"""Policy client for gateway-managed shared resources.

M1 (auth-service) is the policy decision point. This module is the gateway's
enforcement-side client: it maps a request to a typed resource, asks the M1
`authorize`/`accessible` endpoints for a decision, and caches the answer for a
short, bounded time. No owner, plan, team or resource identity is ever taken
from the request body or from a header.

Flag off: nothing here is called. `custom_auth.py` keeps its legacy plan/team
path byte-for-byte.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Mapping

import httpx

RESOURCE_TYPES = ("model", "workflow", "mcp_agent")
SUPPORTED_TYPES = frozenset(RESOURCE_TYPES)
SHARING_METADATA_KEY = "resourceSharing"


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = float(value)
    except ValueError:
        raise RuntimeError(f"{name} must be a number") from None
    return parsed


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value)
    except ValueError:
        raise RuntimeError(f"{name} must be an integer") from None
    return parsed


RESOURCE_SHARING_ENABLED = _env_bool("RESOURCE_SHARING_ENABLED", False)
RESOURCE_AUTH_URL = (
    os.environ.get("RESOURCE_AUTH_URL")
    or os.environ.get("WALLET_AUTH_URL")
    or ""
).rstrip("/")
RESOURCE_CLIENT_ID = os.environ.get("RESOURCE_CLIENT_ID", "")
RESOURCE_CLIENT_SECRET = os.environ.get("RESOURCE_CLIENT_SECRET", "")
RESOURCE_SCOPE = os.environ.get("RESOURCE_AUTH_SCOPE", "resources:authorize")
# The audience the user JWT was verified against; the M1 query carries it so
# auth-service evaluates the same resource policy the token was minted for.
RESOURCE_AUDIENCE = os.environ.get("JWT_AUDIENCE", "")
RESOURCE_CACHE_TTL_S = _env_float("RESOURCE_CACHE_TTL_S", 30.0)
RESOURCE_CACHE_MAX_ENTRIES = _env_int("RESOURCE_CACHE_MAX_ENTRIES", 4096)
RESOURCE_HTTP_TIMEOUT_S = _env_float("RESOURCE_HTTP_TIMEOUT_S", 5.0)

if RESOURCE_CACHE_TTL_S <= 0 or RESOURCE_CACHE_TTL_S > 30:
    raise RuntimeError(
        "RESOURCE_CACHE_TTL_S must be in (0, 30]: a longer cache would delay revocation"
    )
if RESOURCE_CACHE_MAX_ENTRIES <= 0:
    raise RuntimeError("RESOURCE_CACHE_MAX_ENTRIES must be positive")
if RESOURCE_SHARING_ENABLED and (
    not RESOURCE_AUTH_URL or not RESOURCE_CLIENT_ID or not RESOURCE_CLIENT_SECRET
):
    raise RuntimeError(
        "RESOURCE_SHARING_ENABLED requires RESOURCE_AUTH_URL, "
        "RESOURCE_CLIENT_ID and RESOURCE_CLIENT_SECRET"
    )

_MISSING = object()


class ResourceSharingError(Exception):
    """Base class for resource-policy failures."""


class ResourceUnavailable(ResourceSharingError):
    """The policy decision could not be obtained: fail closed with 503."""


class ResourceNotFound(ResourceSharingError):
    """The requested resource cannot be resolved or is denied: uniform 404."""


@dataclass(frozen=True)
class ResourceDecision:
    resource_id: str
    key: str
    resource_type: str
    owner_application_slug: str
    plan_name: str
    team_id: str


class BoundedTTLCache:
    """Tiny LRU with a hard size ceiling and per-entry expiry."""

    def __init__(
        self,
        max_entries: int,
        ttl_s: float,
        clock=time.monotonic,
    ) -> None:
        self._max = max_entries
        self._ttl = ttl_s
        self._clock = clock
        self._entries: OrderedDict[Any, tuple[float, Any]] = OrderedDict()

    def get(self, key: Any) -> Any:
        entry = self._entries.get(key)
        if entry is None:
            return _MISSING
        expires_at, value = entry
        if self._clock() >= expires_at:
            del self._entries[key]
            return _MISSING
        self._entries.move_to_end(key)
        return value

    def set(self, key: Any, value: Any) -> None:
        now = self._clock()
        self._entries[key] = (now + self._ttl, value)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


class ResourceAuthorizer:
    """Machine-authenticated client for the M1 gateway endpoints."""

    def __init__(
        self,
        *,
        auth_url: str = RESOURCE_AUTH_URL,
        client_id: str = RESOURCE_CLIENT_ID,
        client_secret: str = RESOURCE_CLIENT_SECRET,
        scope: str = RESOURCE_SCOPE,
        ttl_s: float = RESOURCE_CACHE_TTL_S,
        max_entries: int = RESOURCE_CACHE_MAX_ENTRIES,
        timeout_s: float = RESOURCE_HTTP_TIMEOUT_S,
        client: httpx.AsyncClient | None = None,
        clock=time.monotonic,
    ) -> None:
        self._auth_url = auth_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._timeout_s = timeout_s
        self._client = client
        self._clock = clock
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._decisions = BoundedTTLCache(max_entries, ttl_s, clock)
        self._accessible = BoundedTTLCache(max_entries, ttl_s, clock)

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
                    token = body["access_token"]
                    expires_in = float(body.get("expires_in", 300))
                except (httpx.HTTPError, KeyError, TypeError, ValueError) as err:
                    raise ResourceUnavailable(
                        "resource policy token unavailable"
                    ) from err
                self._token = token
                self._token_expires_at = self._clock() + expires_in
            return self._token

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            try:
                resp = await self._http().request(
                    method,
                    f"{self._auth_url}{path}",
                    headers={"Authorization": f"Bearer {token}"},
                    **kwargs,
                )
            except httpx.HTTPError as err:
                raise ResourceUnavailable("resource policy unavailable") from err
            if resp.status_code != 401 or attempt == 1:
                return resp
        raise AssertionError("unreachable")

    async def authorize(
        self,
        *,
        subject_id: str,
        client_id: str,
        resource_type: str,
        key: str,
        audience: str,
        request_id: str,
    ) -> ResourceDecision | None:
        if resource_type not in SUPPORTED_TYPES:
            raise ResourceNotFound()
        cache_key = (subject_id, client_id, resource_type, key, audience)
        cached = self._decisions.get(cache_key)
        if cached is not _MISSING:
            return cached

        resp = await self._request(
            "POST",
            "/api/internal/gateway/authorize",
            json={
                "subjectId": subject_id,
                "clientId": client_id,
                "resourceType": resource_type,
                "key": key,
                "audience": audience,
                "requestId": request_id,
            },
        )
        if resp.status_code != 200:
            raise ResourceUnavailable("resource policy unavailable")
        try:
            body = resp.json()
        except ValueError as err:
            raise ResourceUnavailable("resource policy unavailable") from err
        if not isinstance(body, Mapping):
            raise ResourceUnavailable("resource policy unavailable")

        decision = body.get("decision")
        if decision == "deny":
            self._decisions.set(cache_key, None)
            return None
        if decision != "allow":
            raise ResourceUnavailable("resource policy unavailable")

        allow = _allow_decision(body, resource_type, key)
        self._decisions.set(cache_key, allow)
        return allow

    async def accessible(
        self,
        *,
        subject_id: str,
        client_id: str,
        resource_type: str,
        audience: str,
    ) -> tuple[str, ...]:
        if resource_type not in SUPPORTED_TYPES:
            raise ResourceNotFound()
        cache_key = (subject_id, client_id, resource_type, audience)
        cached = self._accessible.get(cache_key)
        if cached is not _MISSING:
            return cached

        resp = await self._request(
            "GET",
            "/api/internal/gateway/resources/accessible",
            params={
                "subjectId": subject_id,
                "clientId": client_id,
                "resourceType": resource_type,
                "audience": audience,
            },
        )
        if resp.status_code != 200:
            raise ResourceUnavailable("resource policy unavailable")
        try:
            body = resp.json()
        except ValueError as err:
            raise ResourceUnavailable("resource policy unavailable") from err
        resources = body.get("resources") if isinstance(body, Mapping) else None
        if not isinstance(resources, list):
            raise ResourceUnavailable("resource policy unavailable")
        keys: list[str] = []
        for item in resources:
            if not isinstance(item, Mapping):
                raise ResourceUnavailable("resource policy unavailable")
            key = item.get("resourceKey")
            if not isinstance(key, str) or not key:
                raise ResourceUnavailable("resource policy unavailable")
            keys.append(key)
        result = tuple(dict.fromkeys(keys))
        self._accessible.set(cache_key, result)
        return result


def _allow_decision(body: Mapping[str, Any], resource_type: str, key: str) -> ResourceDecision:
    owner = body.get("ownerApplicationSlug")
    plan = body.get("planName")
    team = body.get("teamId")
    resource_id = body.get("resourceId")
    if not (
        isinstance(owner, str)
        and owner
        and isinstance(plan, str)
        and plan
        and isinstance(team, str)
        and team
        and isinstance(resource_id, str)
        and resource_id
    ):
        raise ResourceUnavailable("resource policy returned an incomplete decision")
    return ResourceDecision(
        resource_id=resource_id,
        key=key,
        resource_type=resource_type,
        owner_application_slug=owner,
        plan_name=plan,
        team_id=team,
    )


_authorizer: ResourceAuthorizer | None = None


def authorizer() -> ResourceAuthorizer:
    global _authorizer
    if _authorizer is None:
        _authorizer = ResourceAuthorizer()
    return _authorizer


def set_authorizer_for_tests(value: ResourceAuthorizer | None) -> None:
    global _authorizer
    _authorizer = value