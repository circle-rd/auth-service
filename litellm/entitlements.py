"""Resolve a user's LiteLLM entitlement lists from auth-service.

The gateway no longer creates teams or access groups. auth-service returns the
models, agents, MCP servers/tools and accounting resources the subject may use;
LiteLLM enforces those lists on the request. A short cache bounds revocation
latency without letting a long-lived cache mask a downgrade.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Mapping

import httpx

USAGE_METADATA_KEY = "resourceUsage"
ENTITLEMENTS_METADATA_KEY = "gatewayEntitlements"


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} must be set (provisioned by `pnpm llm:setup`)")
    return value


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError:
        raise RuntimeError(f"{name} must be a number") from None
    return parsed


AUTH_URL = _required_env("GATEWAY_ENTITLEMENTS_URL").rstrip("/")
CLIENT_ID = _required_env("WALLET_CLIENT_ID")
CLIENT_SECRET = _required_env("WALLET_CLIENT_SECRET")
SCOPE = os.environ.get("GATEWAY_ENTITLEMENTS_SCOPE", "gateway:entitlements:read")
TTL_S = _env_float("GATEWAY_ENTITLEMENTS_TTL_S", 30.0)
HTTP_TIMEOUT_S = _env_float("GATEWAY_ENTITLEMENTS_HTTP_TIMEOUT_S", 5.0)

if TTL_S <= 0 or TTL_S > 30:
    raise RuntimeError(
        "GATEWAY_ENTITLEMENTS_TTL_S must be in (0, 30]: a longer cache delays revocation"
    )


class EntitlementsUnavailable(Exception):
    """The policy decision could not be obtained: fail closed with 503."""


class EntitlementsDenied(Exception):
    """auth-service refused the token's client: fail closed with 403."""


@dataclass(frozen=True)
class EntitlementResource:
    resource_id: str
    uri: str
    scheme: str
    kind: str
    name: str
    parent_name: str
    application_slug: str
    owner_type: str


@dataclass(frozen=True)
class Entitlements:
    models: tuple[str, ...]
    agents: tuple[str, ...]
    mcp_servers: tuple[str, ...]
    mcp_tool_permissions: dict[str, tuple[str, ...]]
    resources: tuple[EntitlementResource, ...]
    # The signed decision that usage events must present, the person and the
    # application auth-service derived from the token, and when it stops holding.
    decision_id: str = ""
    subject_id: str = ""
    client_id: str = ""
    expires_at: float = float("inf")



def _strings(value: Any, what: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise EntitlementsUnavailable(f"invalid {what}")
    return tuple(dict.fromkeys(value))


def _parse(body: Any) -> Entitlements:
    if not isinstance(body, Mapping):
        raise EntitlementsUnavailable("invalid entitlements payload")
    models = _strings(body.get("models", []), "models")
    agents = _strings(body.get("agents", []), "agents")
    mcp_servers = _strings(body.get("mcpServers", []), "mcpServers")
    tools_raw = body.get("mcpToolPermissions", {})
    if not isinstance(tools_raw, Mapping):
        raise EntitlementsUnavailable("invalid mcpToolPermissions")
    tools: dict[str, tuple[str, ...]] = {}
    for server, names in tools_raw.items():
        if not isinstance(server, str) or not server:
            raise EntitlementsUnavailable("invalid mcpToolPermissions")
        tools[server] = _strings(names, "mcpToolPermissions")
    resources_raw = body.get("resources", [])
    if not isinstance(resources_raw, list):
        raise EntitlementsUnavailable("invalid resources")
    resources: list[EntitlementResource] = []
    for item in resources_raw:
        if not isinstance(item, Mapping):
            raise EntitlementsUnavailable("invalid resource")
        fields = (
            item.get("resourceId"),
            item.get("uri"),
            item.get("scheme"),
            item.get("kind"),
            item.get("name"),
            item.get("parentName", ""),
            item.get("applicationSlug"),
            item.get("ownerType"),
        )
        required = (fields[0], fields[1], fields[2], fields[3], fields[4], fields[6], fields[7])
        if not all(isinstance(field, str) and field for field in required):
            raise EntitlementsUnavailable("invalid resource")
        if not isinstance(fields[5], str):
            raise EntitlementsUnavailable("invalid resource")
        resources.append(
            EntitlementResource(
                resource_id=fields[0],
                uri=fields[1],
                scheme=fields[2],
                kind=fields[3],
                name=fields[4],
                parent_name=fields[5] if isinstance(fields[5], str) else "",
                application_slug=fields[6],
                owner_type=fields[7],
            )
        )
    decision_id = body.get("decisionId")
    subject_id = body.get("subjectId")
    client_id = body.get("clientId")
    expires_raw = body.get("expiresAt")
    if not all(
        isinstance(value, str) and value
        for value in (decision_id, subject_id, client_id, expires_raw)
    ):
        raise EntitlementsUnavailable("invalid decision")
    try:
        expires_at = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
    except ValueError:
        raise EntitlementsUnavailable("invalid decision") from None
    if expires_at.tzinfo is None:
        raise EntitlementsUnavailable("invalid decision")
    return Entitlements(
        models=models,
        agents=agents,
        mcp_servers=mcp_servers,
        mcp_tool_permissions=tools,
        resources=tuple(resources),
        decision_id=decision_id,
        subject_id=subject_id,
        client_id=client_id,
        expires_at=expires_at.timestamp(),
    )


class EntitlementResolver:
    """Machine-authenticated client with a bounded per-token cache.

    The user's access token is forwarded to auth-service, which verifies it and
    derives the person and the application itself. The cache is keyed by a hash
    of the token, so no token is kept, and an entry never outlives the decision
    it holds.
    """

    def __init__(
        self,
        *,
        auth_url: str = AUTH_URL,
        client_id: str = CLIENT_ID,
        client_secret: str = CLIENT_SECRET,
        scope: str = SCOPE,
        ttl_s: float = TTL_S,
        timeout_s: float = HTTP_TIMEOUT_S,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._auth_url = auth_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._client = client
        self._clock = clock
        self._wall_clock = wall_clock
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._cache: dict[str, tuple[Entitlements, float]] = {}

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout_s)
        return self._client

    async def _access_token(self, force: bool = False) -> str:
        async with self._token_lock:
            if (
                force
                or self._token is None
                or self._clock() > self._token_expires_at - 30
            ):
                try:
                    resp = await self._http().post(
                        f"{self._auth_url}/api/auth/oauth2/token",
                        data={"grant_type": "client_credentials", "scope": self._scope},
                        auth=(self._client_id, self._client_secret),
                    )
                    resp.raise_for_status()
                    body = resp.json()
                    self._token = body["access_token"]
                    self._token_expires_at = self._clock() + float(
                        body.get("expires_in", 300)
                    )
                except (httpx.HTTPError, KeyError, TypeError, ValueError) as err:
                    raise EntitlementsUnavailable(
                        "entitlement token unavailable"
                    ) from err
            return self._token

    async def resolve(
        self, user_token: str, subject_id: str, client_id: str
    ) -> Entitlements:
        """Decide for the token's person and application.

        `subject_id` and `client_id` are what the hook verified itself; the
        answer must name the same pair, otherwise it is refused.
        """
        key = hashlib.sha256(user_token.encode("utf-8")).hexdigest()
        now = self._clock()
        cached = self._cache.get(key)
        if cached is not None and now < cached[1]:
            return cached[0]
        if len(self._cache) >= 1024:
            self._cache = {k: v for k, v in self._cache.items() if now < v[1]}

        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            try:
                resp = await self._http().post(
                    f"{self._auth_url}/api/internal/gateway/entitlements",
                    json={"token": user_token},
                    headers={"Authorization": f"Bearer {token}"},
                )
            except httpx.HTTPError as err:
                raise EntitlementsUnavailable("entitlements unavailable") from err
            if resp.status_code == 401 and attempt == 0:
                continue
            if resp.status_code == 403:
                raise EntitlementsDenied("client not allowed")
            if resp.status_code != 200:
                raise EntitlementsUnavailable("entitlements unavailable")
            try:
                entitlements = _parse(resp.json())
            except ValueError as err:
                raise EntitlementsUnavailable("entitlements unavailable") from err
            if (
                entitlements.subject_id != subject_id
                or entitlements.client_id != client_id
            ):
                raise EntitlementsUnavailable("entitlements mismatch")
            remaining = entitlements.expires_at - self._wall_clock()
            if remaining <= 0:
                raise EntitlementsUnavailable("entitlements already expired")
            self._cache[key] = (entitlements, now + min(self._ttl_s, remaining))
            return entitlements
        raise AssertionError("unreachable")


_resolver: EntitlementResolver | None = None


def resolver() -> EntitlementResolver:
    global _resolver
    if _resolver is None:
        _resolver = EntitlementResolver()
    return _resolver


def set_resolver_for_tests(value: EntitlementResolver | None) -> None:
    global _resolver
    _resolver = value
