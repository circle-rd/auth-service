"""Validate auth-service access tokens (JWT) for the LiteLLM proxy.

LiteLLM's native JWT auth is Enterprise-only, so this hook is wired through
`general_settings.custom_auth`.

Each application with LiteLLM support has a gateway team named after its slug
(the token's `azp`), created closed by auth-service. A gateway administrator
gives the team its models, MCP servers, budget and limits in the LiteLLM UI. The
team is read here and copied onto the request identity, because with a custom
auth LiteLLM does not apply the team's block, rate limits or MCP permissions by
itself (model access and budget are checked, see `custom_auth_run_common_checks`).
"""

import asyncio
import hmac
import os
import re
import time

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
        raise RuntimeError(f"{name} must be set (run `pnpm llm:setup`)")
    return value


JWKS_URL = _required_env("JWT_PUBLIC_KEY_URL")
ISSUER = _required_env("JWT_ISSUER")
AUDIENCE = _required_env("JWT_AUDIENCE")
MASTER_KEY = _required_env("LITELLM_MASTER_KEY")
_required_env("LITELLM_SALT_KEY")
# auth-service signs access tokens with EdDSA only.
ALGORITHMS = ["EdDSA"]
REFRESH_COOLDOWN_S = 30

# Per-server MCP routes (/{server}/mcp) are not part of LiteLLM's LLM route list.
MCP_SERVER_ROUTE_RE = re.compile(r"^/[^/]+/mcp(/.*)?$")

_keys: dict[str, jwt.PyJWK] = {}
_last_fetch = 0.0
_lock = asyncio.Lock()


def _reject(message: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param="api_key", code=401)


def _is_client_route(path: str) -> bool:
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


def _forbid(message: str, param: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param=param, code=403)


async def _application_team(app_slug: str):
    """The gateway team of the calling application; 403 while it has none."""
    # Imported late: the proxy module is still loading when this file is imported.
    from litellm.proxy.auth.auth_checks import get_team_object
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_logging_obj,
        user_api_key_cache,
    )

    try:
        return await get_team_object(
            team_id=app_slug,
            prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache,
            proxy_logging_obj=proxy_logging_obj,
        )
    except Exception:
        raise _forbid(
            f"Application '{app_slug}' has no team on this gateway: "
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
    if not _is_client_route(request.url.path):
        raise ProxyException(
            message="This endpoint is not available to users",
            type="auth_error",
            param="route",
            code=403,
        )

    team = await _application_team(claims["azp"])
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
