"""Discovery narrowing for shared resources.

LiteLLM v1.108.3 only exposes a listing callback for `/v1/models`; agents and
MCP servers are narrowed by wrapping the read-only function each route already
calls. A missing or broken seam answers 503 rather than an unfiltered list.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from fastapi import HTTPException
from litellm._logging import verbose_proxy_logger as log
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import ProxyException, UserAPIKeyAuth

from resource_routing import MCP_AGENT, MODEL, WORKFLOW, _router, resolve_model_key
from resource_sharing import (
    RESOURCE_AUDIENCE,
    RESOURCE_SHARING_ENABLED,
    SHARING_METADATA_KEY,
    ResourceNotFound,
    ResourceUnavailable,
    authorizer,
)




def _sharing_identity(user_api_key_dict: Any) -> tuple[str, str] | None:
    if not RESOURCE_SHARING_ENABLED:
        return None
    if not getattr(user_api_key_dict, "authenticated_by_custom_auth", False):
        return None
    role = getattr(user_api_key_dict, "user_role", None)
    if role in ("proxy_admin", "PROXY_ADMIN"):
        return None
    metadata = getattr(user_api_key_dict, "metadata", None) or {}
    if not isinstance(metadata, Mapping) or not metadata.get(SHARING_METADATA_KEY):
        return None
    subject = getattr(user_api_key_dict, "user_id", None)
    client = metadata.get("azp")
    if not isinstance(subject, str) or not subject:
        return None
    if not isinstance(client, str) or not client:
        return None
    return subject, client


async def _accessible_keys(user_api_key_dict: Any, resource_type: str) -> frozenset[str]:
    identity = _sharing_identity(user_api_key_dict)
    if identity is None:
        return frozenset()
    keys = await authorizer().accessible(
        subject_id=identity[0],
        client_id=identity[1],
        resource_type=resource_type,
        audience=_audience(),
    )
    return frozenset(keys)


def _audience() -> str:
    return RESOURCE_AUDIENCE


def _discovery_unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "error": {
                "message": "Resource catalogue unavailable",
                "type": "service_unavailable",
                "code": "503",
            }
        },
    )


def filter_agent_entries(agents: Sequence[Any], keys: frozenset[str]) -> tuple[Any, ...]:
    return tuple(
        agent
        for agent in agents
        if getattr(agent, "agent_name", None) in keys
    )


def filter_mcp_server_entries(
    servers: Sequence[Any], keys: frozenset[str]
) -> list[Any]:
    return [
        server
        for server in servers
        if getattr(server, "server_name", None) in keys
        or getattr(server, "alias", None) in keys
    ]


_INSTALLED = False


def ensure_discovery_filters() -> bool:
    """Install response filters for the two discovery routes without hooks.

    LiteLLM v1.108.3 exposes a listing callback for models only. Agents and MCP
    servers are narrowed by wrapping the function each route already calls.
    Any failure leaves the caller with a 503 (fail closed), never an unfiltered
    list.
    """
    global _INSTALLED
    if _INSTALLED:
        return True
    try:
        from litellm.proxy.agent_endpoints import endpoints as agent_endpoints
        from litellm.proxy.management_endpoints import (
            mcp_management_endpoints as mcp_endpoints,
        )

        original_agents = agent_endpoints.accessible_agents
        if not getattr(original_agents, "_circle_resource_filter", False):

            async def filtered_agents(user_api_key_auth, *args, **kwargs):  # noqa: ANN001
                agents = await original_agents(user_api_key_auth, *args, **kwargs)
                identity = _sharing_identity(user_api_key_auth)
                if identity is None:
                    return agents
                try:
                    keys = await _accessible_keys(user_api_key_auth, WORKFLOW)
                except ResourceUnavailable as err:
                    raise _discovery_unavailable() from err
                return filter_agent_entries(agents, keys)

            filtered_agents._circle_resource_filter = True  # type: ignore[attr-defined]
            agent_endpoints.accessible_agents = filtered_agents

        original_servers = mcp_endpoints._resolve_accessible_mcp_servers
        if not getattr(original_servers, "_circle_resource_filter", False):

            async def filtered_servers(user_api_key_dict):  # noqa: ANN001
                servers = await original_servers(user_api_key_dict)
                identity = _sharing_identity(user_api_key_dict)
                if identity is None:
                    return servers
                try:
                    keys = await _accessible_keys(user_api_key_dict, MCP_AGENT)
                except ResourceUnavailable as err:
                    raise _discovery_unavailable() from err
                return filter_mcp_server_entries(servers, keys)

            filtered_servers._circle_resource_filter = True  # type: ignore[attr-defined]
            mcp_endpoints._resolve_accessible_mcp_servers = filtered_servers

        _INSTALLED = True
        return True
    except Exception as err:  # noqa: BLE001 - a missing seam must not open discovery
        log.warning("resource sharing: discovery filter unavailable: %s", type(err).__name__)
        return False


class ResourceSharingLogger(CustomLogger):
    """Narrow `/v1/models` to the caller's accessible model resources."""

    async def async_filter_listed_models(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        model_names: Sequence[str],
    ) -> Sequence[str]:
        if not RESOURCE_SHARING_ENABLED:
            return model_names
        if _sharing_identity(user_api_key_dict) is None:
            return model_names
        try:
            keys = await _accessible_keys(user_api_key_dict, MODEL)
            if not keys:
                return ()
            router = _router()
            kept: list[str] = []
            for name in model_names:
                try:
                    resolved = resolve_model_key(router, name)
                except ResourceNotFound:
                    continue
                if resolved in keys:
                    kept.append(name)
            return kept
        except ResourceUnavailable:
            raise ProxyException(
                message="Resource catalogue unavailable; try again",
                type="service_unavailable",
                param="api_key",
                code=503,
            ) from None

resource_sharing_logger = ResourceSharingLogger()
