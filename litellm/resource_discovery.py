"""Narrow `/v1/models` to the entitlement list attached by custom auth.

The identity already carries the canonical model allowlist from auth-service.
Agents and MCP servers are narrowed by LiteLLM's own object-permission checks;
this callback only covers the model listing, which has no native allowlist hook.
"""

from __future__ import annotations

from typing import Sequence

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth


class ResourceSharingLogger(CustomLogger):
    """Keep only the models the custom-auth identity may call."""

    async def async_filter_listed_models(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        model_names: Sequence[str],
    ) -> Sequence[str]:
        if not getattr(user_api_key_dict, "authenticated_by_custom_auth", False):
            return model_names
        if user_api_key_dict.user_role in ("proxy_admin", "PROXY_ADMIN"):
            return model_names
        allowed = getattr(user_api_key_dict, "models", None)
        if not isinstance(allowed, list):
            return model_names
        allowset = {name for name in allowed if isinstance(name, str)}
        if not allowset:
            return ()
        return tuple(name for name in model_names if name in allowset)


resource_sharing_logger = ResourceSharingLogger()
