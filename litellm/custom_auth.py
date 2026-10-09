"""Validate auth-service access tokens (JWT) for the LiteLLM proxy.

LiteLLM's native JWT auth is Enterprise-only, so this hook is wired through
`general_settings.custom_auth`.
"""

import asyncio
import hmac
import os
import time

import httpx
import jwt
from fastapi import Request
from litellm.proxy._types import ProxyException, UserAPIKeyAuth



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

_keys: dict[str, jwt.PyJWK] = {}
_last_fetch = 0.0
_lock = asyncio.Lock()


def _reject(message: str) -> ProxyException:
    return ProxyException(message=message, type="auth_error", param="api_key", code=401)


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


async def user_api_key_auth(request: Request, api_key: str) -> UserAPIKeyAuth:
    if not api_key:
        raise _reject("No api key passed in")
    if hmac.compare_digest(api_key, MASTER_KEY):
        return UserAPIKeyAuth(api_key=api_key, user_role="proxy_admin")

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

    return UserAPIKeyAuth(
        api_key=f"jwt:{claims['sub']}",
        user_id=claims["sub"],
        metadata={"azp": claims["azp"]},
    )
