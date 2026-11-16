"""Resolve a user's LiteLLM entitlement lists from auth-service.

The gateway no longer creates teams or access groups. auth-service returns the
models, agents, MCP servers/tools and accounting resources the subject may use;
LiteLLM enforces those lists on the request. A short cache bounds revocation
latency without letting a long-lived cache mask a downgrade.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping

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
    owner_id: str


@dataclass(frozen=True)
class Entitlements:
    models: tuple[str, ...]
    agents: tuple[str, ...]
    mcp_servers: tuple[str, ...]
    mcp_tool_permissions: dict[str, tuple[str, ...]]
    resources: tuple[EntitlementResource, ...]




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
            item.get("ownerId"),
        )
        required = (fields[0], fields[1], fields[2], fields[3], fields[4], fields[6], fields[7], fields[8])
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
                owner_id=fields[8],
            )
        )
    return Entitlements(
        models=models,
        agents=agents,
        mcp_servers=mcp_servers,
        mcp_tool_permissions=tools,
        resources=tuple(resources),
    )


class EntitlementResolver:
    """Machine-authenticated client with a bounded per-(user, app) cache."""

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
        clock=time.monotonic,
    ) -> None:
        self._auth_url = auth_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._client = client
        self._clock = clock
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._cache: dict[tuple[str, str], tuple[Entitlements, float]] = {}

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

    async def resolve(self, user_id: str, application_slug: str) -> Entitlements:
        key = (user_id, application_slug)
        cached = self._cache.get(key)
        now = self._clock()
        if cached is not None and now - cached[1] < self._ttl_s:
            return cached[0]
        if len(self._cache) >= 1024:
            self._cache = {
                key: value
                for key, value in self._cache.items()
                if now - value[1] < self._ttl_s
            }

        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            try:
                resp = await self._http().get(
                    f"{self._auth_url}/api/internal/gateway/users/{user_id}/entitlements",
                    params={"applicationSlug": application_slug},
                    headers={"Authorization": f"Bearer {token}"},
                )
            except httpx.HTTPError as err:
                raise EntitlementsUnavailable("entitlements unavailable") from err
            if resp.status_code == 401 and attempt == 0:
                continue
            if resp.status_code != 200:
                raise EntitlementsUnavailable("entitlements unavailable")
            try:
                entitlements = _parse(resp.json())
            except ValueError as err:
                raise EntitlementsUnavailable("entitlements unavailable") from err
            self._cache[key] = (entitlements, now)
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
