"""Validate auth-service access tokens and attach gateway entitlements.

LiteLLM's native JWT auth is Enterprise-only, so this hook is wired through
`general_settings.custom_auth`.

auth-service is the decision point. At authentication time it returns the
models, agents and MCP servers/tools the subject may reach, derived from the
generic resource grants, application membership and plan grants. The hook puts
those lists on the request identity as a key-level object permission; LiteLLM
enforces them on the request. No team, access group or per-request authorize
call is involved.
"""

import asyncio
import hashlib
import hmac
import json
import os
import re
import time

import httpx
import jwt
import litellm
from fastapi import Request
from litellm.proxy._types import (
    LiteLLM_ObjectPermissionTable,
    LitellmUserRoles,
    ProxyException,
    SpecialModelNames,
    UserAPIKeyAuth,
)
from litellm.proxy.auth.route_checks import RouteChecks
from litellm.proxy._experimental.mcp_server.auth.user_api_key_auth_mcp import (
    SpecialMCPServerNames,
)

from entitlements import (
    ENTITLEMENTS_METADATA_KEY,
    USAGE_METADATA_KEY,
    Entitlements,
    EntitlementsDenied,
    EntitlementsRejected,
    EntitlementsUnavailable,
    resolver,
)

# auth-service sets no team budget; post-custom-auth checks keep model and
# fallback enforcement consistent with the native auth path.
litellm.enable_post_custom_auth_checks = True


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} must be set (provisioned by `pnpm llm:setup`)")
    return value


JWKS_URL = _required_env("JWT_PUBLIC_KEY_URL")
ISSUER = _required_env("JWT_ISSUER")
# Comma-separated so a gateway can also accept tokens minted for another
# auth-service resource, such as the reverse relay, without losing its own
# audience check.
AUDIENCES = [
    value.strip() for value in _required_env("JWT_AUDIENCE").split(",") if value.strip()
]
MASTER_KEY = _required_env("LITELLM_MASTER_KEY")
_required_env("LITELLM_SALT_KEY")
ALGORITHMS = ["EdDSA", "ES256", "RS256"]
REFRESH_COOLDOWN_S = 30

# An empty LiteLLM model allowlist means "all models". A non-existent sentinel
# turns an empty entitlement into a deny while keeping the list explicit.
NO_MODEL_SENTINEL = SpecialModelNames.no_default_models.value
NO_MCP_SENTINEL = SpecialMCPServerNames.no_mcp_servers.value

MCP_SERVER_ROUTE_RE = re.compile(r"^/(?!(?i:v1)/)[^/]+/mcp(/.*)?$")
PERSONAL_KEY_RE = re.compile(r"^cgk_[A-Za-z0-9_-]{43}$")
DISCOVERY_ROUTES = frozenset({"/v1/agents", "/v1/mcp/server"})

_keys: dict[str, jwt.PyJWK] = {}
_last_fetch = 0.0
_lock = asyncio.Lock()


def _reject(message: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param="api_key", code=401)


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


def _permission(entitlements: Entitlements) -> LiteLLM_ObjectPermissionTable:
    models = list(entitlements.models) or [NO_MODEL_SENTINEL]
    mcp_servers = list(entitlements.mcp_servers) or [NO_MCP_SENTINEL]
    tools = {
        server: list(names)
        for server, names in entitlements.mcp_tool_permissions.items()
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "models": models,
                "agents": entitlements.agents,
                "mcp": mcp_servers,
                "tools": tools,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:24]
    return LiteLLM_ObjectPermissionTable(
        object_permission_id=f"auth-service:{fingerprint}",
        models=models,
        agents=list(entitlements.agents),
        mcp_servers=mcp_servers,
        mcp_tool_permissions=tools or None,
    )


def _usage_context(entitlements: Entitlements) -> dict:
    # The person and the application are not repeated here: a usage event names
    # the decision, and auth-service reads both from it.
    return {
        "decisionId": entitlements.decision_id,
        "resources": [
            {
                "resourceId": resource.resource_id,
                "uri": resource.uri,
                "scheme": resource.scheme,
                "kind": resource.kind,
                "name": resource.name,
                "parentName": resource.parent_name,
                "applicationSlug": resource.application_slug,
                "ownerType": resource.owner_type,
            }
            for resource in entitlements.resources
        ],
    }


def _identity_from(
    subject_id: str,
    client_id: str,
    entitlements: Entitlements,
    api_key: str,
    preferred_username: str = "",
) -> UserAPIKeyAuth:
    return UserAPIKeyAuth(
        api_key=api_key,
        user_id=subject_id,
        user_role=LitellmUserRoles.CUSTOMER,
        models=list(entitlements.models) or [NO_MODEL_SENTINEL],
        object_permission=_permission(entitlements),
        metadata={
            "azp": client_id,
            "preferredUsername": preferred_username,
            ENTITLEMENTS_METADATA_KEY: {
                "models": list(entitlements.models),
                "agents": list(entitlements.agents),
                "mcpServers": list(entitlements.mcp_servers),
            },
            USAGE_METADATA_KEY: _usage_context(entitlements),
        },
    )


def _identity(claims: dict, entitlements: Entitlements) -> UserAPIKeyAuth:
    subject_id = claims["sub"]
    return _identity_from(
        subject_id,
        claims["azp"],
        entitlements,
        f"jwt:{subject_id}",
        str(claims.get("preferred_username", "")),
    )


async def user_api_key_auth(
    request: Request, api_key: str
) -> UserAPIKeyAuth | None:
    if not api_key:
        raise _reject("No api key passed in")
    if hmac.compare_digest(api_key, MASTER_KEY):
        return UserAPIKeyAuth(api_key=api_key, user_role="proxy_admin")

    # LiteLLM virtual keys: the admin UI signs in with one created at login, and
    # administrators may issue service keys. Returning None lets LiteLLM validate
    # them itself; an unknown key is refused there.
    if api_key.startswith("sk-"):
        return None

    # Personal gateway keys are resolved on every request and never cached:
    # revocation takes effect on the next call.
    if api_key.startswith("cgk_"):
        if not PERSONAL_KEY_RE.match(api_key):
            raise _reject("Invalid or expired access token")
        if not _is_client_route(request.url.path, request.method):
            raise ProxyException(
                message="This endpoint is not available to users",
                type="auth_error",
                param="route",
                code=403,
            )
        try:
            entitlements = await resolver().resolve_key(api_key)
        except EntitlementsRejected:
            raise _reject("Invalid or expired access token") from None
        except EntitlementsDenied:
            raise ProxyException(
                message="This key is not allowed to use shared resources",
                type="auth_error",
                param="api_key",
                code=403,
            ) from None
        except EntitlementsUnavailable:
            raise _unavailable("Could not resolve entitlements; try again") from None
        return _identity_from(
            entitlements.subject_id,
            entitlements.client_id,
            entitlements,
            f"cgk:{entitlements.key_id}",
        )

    try:
        kid = jwt.get_unverified_header(api_key).get("kid")
        if not kid:
            raise _reject("Token has no kid")
        key = await _signing_key(kid)
        claims = jwt.decode(
            api_key,
            key.key,
            algorithms=ALGORITHMS,
            audience=AUDIENCES,
            issuer=ISSUER,
            options={"require": ["exp", "iss", "aud", "sub", "azp"]},
        )
    except ProxyException:
        raise
    except (jwt.PyJWTError, httpx.HTTPError, KeyError):
        raise _reject("Invalid or expired access token") from None

    if claims["sub"] == claims["azp"]:
        raise _reject("User-bound access token required")

    # Users only reach the LLM and MCP routes: without this, a valid token could
    # mint LiteLLM virtual keys or create users, teams and models.
    if not _is_client_route(request.url.path, request.method):
        raise ProxyException(
            message="This endpoint is not available to users",
            type="auth_error",
            param="route",
            code=403,
        )

    try:
        entitlements = await resolver().resolve(
            api_key, claims["sub"], claims["azp"]
        )
    except EntitlementsDenied:
        raise ProxyException(
            message="This client is not allowed to use shared resources",
            type="auth_error",
            param="api_key",
            code=403,
        ) from None
    except EntitlementsUnavailable:
        raise _unavailable("Could not resolve entitlements; try again") from None
    return _identity(claims, entitlements)
