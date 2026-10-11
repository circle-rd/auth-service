"""Validate auth-service access tokens (JWT) for the LiteLLM proxy.

LiteLLM's native JWT auth is Enterprise-only, so this hook is wired through
`general_settings.custom_auth`.
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
    LiteLLM_ObjectPermissionTable,
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

# MCP servers registered in this access group are available to every signed-in
# user; any other server stays private to administrators.
MCP_USER_ACCESS_GROUP = os.environ.get("MCP_USER_ACCESS_GROUP", "circle-users")

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

    return UserAPIKeyAuth(
        api_key=f"jwt:{claims['sub']}",
        user_id=claims["sub"],
        user_role=LitellmUserRoles.CUSTOMER,
        object_permission=LiteLLM_ObjectPermissionTable(
            object_permission_id=f"{MCP_USER_ACCESS_GROUP}-access",
            mcp_access_groups=[MCP_USER_ACCESS_GROUP],
        ),
        metadata={"azp": claims["azp"]},
    )
