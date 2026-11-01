"""Validate auth-service access tokens (JWT) for the LiteLLM proxy.

LiteLLM's native JWT auth is Enterprise-only, so this hook is wired through
`general_settings.custom_auth`.

An application with LiteLLM support has one gateway team per subscription plan
(`<applicationSlug>:<planSlug>`), created closed by auth-service, each carrying
an empty access group a gateway administrator fills with models, MCP servers and
agents. The plan of the calling user, and the team it maps to, are resolved from
auth-service (never from a claim, so a downgrade takes effect at once); the team
is then read and copied onto the request identity, because with a custom auth
LiteLLM does not apply the team's block, rate limits or MCP permissions by itself
(model access and budget are checked, see `custom_auth_run_common_checks`).
"""

import asyncio
import hmac
import os
import re
import time
from urllib.parse import quote

import httpx
import jwt
from fastapi import Request
from litellm.proxy._types import (
    LitellmUserRoles,
    ProxyException,
    UserAPIKeyAuth,
)
from litellm.proxy.auth.route_checks import RouteChecks


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} must be set (provisioned by `pnpm llm:setup` or the litellm-setup service)")
    return value


JWKS_URL = _required_env("JWT_PUBLIC_KEY_URL")
ISSUER = _required_env("JWT_ISSUER")
AUDIENCE = _required_env("JWT_AUDIENCE")
MASTER_KEY = _required_env("LITELLM_MASTER_KEY")
_required_env("LITELLM_SALT_KEY")
# auth-service signs with EdDSA by default, or RS256 (JWT_PRIMARY_ALG). The key
# type comes from the JWKS entry, so the two asymmetric algorithms cannot be
# confused with each other or with a shared-secret one.
ALGORITHMS = ["EdDSA", "RS256"]
REFRESH_COOLDOWN_S = 30

# Resolving a user's plan/team. The machine client is the same one the wallet
# hook uses, and the scope is the one it already holds (`wallet:read`): reusing
# an existing scope means an in-place upgrade needs no new scope grant (which
# would require an administrator without MFA) before the gateway can serve.
PLAN_AUTH_URL = _required_env("WALLET_AUTH_URL").rstrip("/")
PLAN_CLIENT_ID = _required_env("WALLET_CLIENT_ID")
PLAN_CLIENT_SECRET = _required_env("WALLET_CLIENT_SECRET")
PLAN_SCOPE = "wallet:read"
# How long a resolved plan is reused. Short: a plan change (an upgrade or a
# downgrade) must take effect without waiting for the access token to expire.
PLAN_TTL_S = float(os.environ.get("GATEWAY_PLAN_TTL_S", "30"))
HTTP_TIMEOUT_S = 5.0

# Per-server MCP routes (/{server}/mcp) are not part of LiteLLM's LLM route list.
# `v1` is no server name: without the lookahead, the management routes
# /v1/mcp/server and /v1/mcp/sessions would read as the routes of a server "v1".
MCP_SERVER_ROUTE_RE = re.compile(r"^/(?!(?i:v1)/)[^/]+/mcp(/.*)?$")

# Read-only discovery of what the caller's plan reaches. LiteLLM treats both as
# management routes, yet serves them to non-admins: the agent list is limited to
# the caller's grants, and the MCP server list to the accessible servers with
# their url, headers, env and credentials stripped. Exact paths, GET only: the
# same paths accept writes for administrators.
DISCOVERY_ROUTES = frozenset({"/v1/agents", "/v1/mcp/server"})

_keys: dict[str, jwt.PyJWK] = {}
_last_fetch = 0.0
_lock = asyncio.Lock()


def _reject(message: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param="api_key", code=401)


def _forbid(message: str, param: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param=param, code=403)


def _unavailable(message: str) -> ProxyException:
    return ProxyException(
        message=message, type="service_unavailable", param="api_key", code=503
    )


def _is_client_route(path: str, method: str) -> bool:
    if method == "GET" and path in DISCOVERY_ROUTES:
        return True
    return RouteChecks.is_llm_api_route(route=path) or bool(
        MCP_SERVER_ROUTE_RE.match(path)
    )


async def _signing_key(kid: str) -> jwt.PyJWK:
    global _last_fetch
    if kid in _keys:
        return _keys[kid]
    async with _lock:
        # An unknown kid (key rotation) refetches the JWKS, at most once per cooldown.
        if kid not in _keys and time.monotonic() - _last_fetch > REFRESH_COOLDOWN_S:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(JWKS_URL)
                resp.raise_for_status()
            _keys.clear()
            for jwk in resp.json()["keys"]:
                _keys[jwk["kid"]] = jwt.PyJWK(jwk)
            _last_fetch = time.monotonic()
    if kid not in _keys:
        raise _reject("Unknown signing key")
    return _keys[kid]


class _PlanResolver:
    """Resolves a (user, application) pair to its gateway team via auth-service."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        # (user_id, azp) -> (team_id | None, fetched at)
        self._cache: dict[tuple[str, str], tuple[str | None, float]] = {}

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
        return self._client

    async def _access_token(self, force: bool = False) -> str:
        async with self._token_lock:
            if force or self._token is None or time.monotonic() > self._token_expires_at - 30:
                resp = await self._http().post(
                    f"{PLAN_AUTH_URL}/api/auth/oauth2/token",
                    data={"grant_type": "client_credentials", "scope": PLAN_SCOPE},
                    auth=(PLAN_CLIENT_ID, PLAN_CLIENT_SECRET),
                )
                resp.raise_for_status()
                body = resp.json()
                self._token = body["access_token"]
                self._token_expires_at = time.monotonic() + float(body.get("expires_in", 300))
            return self._token

    async def team_id(self, user_id: str, application_slug: str) -> str | None:
        key = (user_id, application_slug)
        cached = self._cache.get(key)
        now = time.monotonic()
        if cached is not None and now - cached[1] < PLAN_TTL_S:
            return cached[0]
        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            resp = await self._http().get(
                f"{PLAN_AUTH_URL}/api/internal/gateway/users/{quote(user_id, safe='')}/plan",
                params={"applicationSlug": application_slug},
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 401 and attempt == 0:
                continue
            resp.raise_for_status()
            team_id = resp.json().get("teamId")
            self._cache[key] = (team_id, now)
            return team_id
        raise AssertionError("unreachable")


_plans = _PlanResolver()


async def _application_team(team_id: str, app_slug: str):
    """The gateway team of the caller's plan; 403 while it does not exist."""
    # Imported late: the proxy module is still loading when this file is imported.
    from litellm.proxy.auth.auth_checks import get_team_object
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_logging_obj,
        user_api_key_cache,
    )

    try:
        return await get_team_object(
            team_id=team_id,
            prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache,
            proxy_logging_obj=proxy_logging_obj,
        )
    except Exception:
        raise _forbid(
            f"Application '{app_slug}' has no team for this plan on this gateway: "
            "ask an administrator to enable LiteLLM support for it",
            "team",
        ) from None


async def user_api_key_auth(
    request: Request, api_key: str
) -> UserAPIKeyAuth | None:
    if not api_key:
        raise _reject("No api key passed in")
    if hmac.compare_digest(api_key, MASTER_KEY):
        return UserAPIKeyAuth(api_key=api_key, user_role="proxy_admin")

    # LiteLLM virtual keys: the admin UI signs in with one created at login, and
    # administrators may issue service keys. Returning None lets LiteLLM validate
    # them itself; an unknown key is refused there. Users cannot mint them (see
    # the route allow list below), and an auth-service token is a JWT, never `sk-`.
    if api_key.startswith("sk-"):
        return None

    try:
        kid = jwt.get_unverified_header(api_key).get("kid")
        if not kid:
            raise _reject("Token has no kid")
        key = await _signing_key(kid)
        claims = jwt.decode(
            api_key,
            key.key,
            algorithms=ALGORITHMS,
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["exp", "iss", "aud", "sub", "azp"]},
        )
    except ProxyException:
        raise
    except (jwt.PyJWTError, httpx.HTTPError, KeyError):
        raise _reject("Invalid or expired access token") from None

    # client_credentials tokens carry no user: sub equals the OAuth client id.
    if claims["sub"] == claims["azp"]:
        raise _reject("User-bound access token required")

    # Users only reach the LLM and MCP routes: without this, a valid token could
    # mint LiteLLM virtual keys (/key/generate) that outlive auth-service access,
    # or create users and teams. Administration stays on the master key.
    if not _is_client_route(request.url.path, request.method):
        raise ProxyException(
            message="This endpoint is not available to users",
            type="auth_error",
            param="route",
            code=403,
        )

    try:
        team_id = await _plans.team_id(claims["sub"], claims["azp"])
    except Exception:
        raise _unavailable(
            "Could not resolve the plan for this token; try again"
        ) from None
    if not team_id:
        raise _forbid(
            f"Application '{claims['azp']}' grants this user no plan", "team"
        )

    team = await _application_team(team_id, claims["azp"])
    return UserAPIKeyAuth(
        api_key=f"jwt:{claims['sub']}",
        user_id=claims["sub"],
        user_role=LitellmUserRoles.CUSTOMER,
        team_id=team.team_id,
        team_blocked=team.blocked,
        team_models=team.models,
        team_rpm_limit=team.rpm_limit,
        team_tpm_limit=team.tpm_limit,
        team_max_budget=team.max_budget,
        team_spend=team.spend,
        team_metadata=team.metadata,
        team_object_permission_id=team.object_permission_id,
        team_object_permission=getattr(team, "object_permission", None),
        metadata={"azp": claims["azp"]},
    )
