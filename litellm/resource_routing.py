"""Map a LiteLLM request to a canonical shared-resource key, then enforce it.

The mapping is deliberately narrow: only the three resource types whose
execution exists in LiteLLM v1.108.3 are admitted (`model`, `workflow` for
A2A agents, `mcp_agent` for MCP servers). Anything else is refused with the
same 404 an unknown resource gets, so a caller cannot distinguish "not shared"
from "does not exist".

Owner identity is never read from the request. The only authority is the
LiteLLM-side resource registry plus the M1 decision; both are server-side.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import litellm
from litellm.proxy._types import ProxyException, UserAPIKeyAuth
from litellm.proxy.auth.auth_utils import (
    fallback_target_model_name,
    get_model_from_request,
    request_fallback_model_names,
)
from litellm.proxy.auth.route_checks import RouteChecks
from litellm.router_utils.common_utils import resolve_served_model
from litellm.router_utils.fallback_event_handlers import (
    get_fallback_model_group_for_lookup_groups,
)

from resource_sharing import (
    RESOURCE_SHARING_ENABLED,
    ResourceDecision,
    ResourceNotFound,
    ResourceUnavailable,
    authorizer,
)

# A2A agent execution. `discover` is an admin write and never reaches this.
A2A_ROUTE_RE = re.compile(r"^/(?:v1/)?a2a/([^/]+)(?:/.*)?$")
MCP_TRANSPORT_RE = re.compile(r"^/(?!(?i:v1)/)[^/]+/mcp(/.*)?$")
MCP_AGGREGATE_RE = re.compile(r"^/mcp(/.*)?$")
MODEL_DISCOVERY_PREFIX = "/v1/models"
AGENT_DISCOVERY = "/v1/agents"
MCP_DISCOVERY = "/v1/mcp/server"

DISCOVERY = "discovery"
MODEL = "model"
WORKFLOW = "workflow"
MCP_AGENT = "mcp_agent"
UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class SharingContext:
    team_id: str
    subject_id: str
    client_id: str
    audience: str
    resources: tuple[ResourceDecision, ...]


def classify_route(path: str, method: str) -> str:
    """The shareable resource class of a route, or `unsupported`.

    Discovery is listed first because GET `/v1/models/{id}` must be filtered by
    the listing callback rather than treated as an execution request.
    """
    method = method.upper()
    if method == "GET":
        if path == MODEL_DISCOVERY_PREFIX or path.startswith(
            MODEL_DISCOVERY_PREFIX + "/"
        ):
            return DISCOVERY
        if path in (AGENT_DISCOVERY, MCP_DISCOVERY):
            return DISCOVERY
    match = A2A_ROUTE_RE.match(path)
    if match and match.group(1) != "discover":
        return WORKFLOW
    if MCP_TRANSPORT_RE.match(path) or MCP_AGGREGATE_RE.match(path):
        return MCP_AGENT
    if RouteChecks.is_llm_api_route(route=path):
        return MODEL
    return UNSUPPORTED


async def _read_body(request: Any) -> dict[str, Any]:
    from litellm.proxy.common_utils.http_parsing_utils import read_request_body

    body = await read_request_body(request=request)
    return body if isinstance(body, dict) else {}


def _router() -> Any:
    from litellm.proxy.proxy_server import llm_router

    if llm_router is None:
        raise ResourceUnavailable("model registry unavailable")
    return llm_router


def _model_names(router: Any) -> frozenset[str]:
    try:
        return frozenset(router.get_model_names() or ())
    except Exception as err:  # noqa: BLE001 - registry failure is fail-closed
        raise ResourceUnavailable("model registry unavailable") from err


def resolve_model_key(router: Any, requested: str) -> str:
    """Canonical model-group key for a requested public name.

    Alias and fallback targets resolve through the router's own maps, never
    through a client-supplied owner or deployment id. A direct deployment id
    is refused unless LiteLLM also advertises it as a model group.
    """
    if not isinstance(requested, str) or not requested:
        raise ResourceNotFound()
    names = _model_names(router)
    target = resolve_served_model(
        requested,
        getattr(litellm, "model_alias_map", None),
        {},
        getattr(router, "model_group_alias", {}) or {},
    )
    if not isinstance(target, str) or not target:
        raise ResourceNotFound()
    try:
        direct_deployment = router.get_deployment(requested) is not None
        configured = target in names or bool(router.get_model_list(model_name=target))
    except Exception as err:  # noqa: BLE001 - registry failure is fail-closed
        raise ResourceUnavailable("model registry unavailable") from err
    if direct_deployment and requested not in names:
        raise ResourceNotFound()
    if not configured:
        raise ResourceNotFound()
    return target


def _fallback_model_names(router: Any, model_group: str) -> tuple[str, ...]:
    names: list[str] = []
    for attr in ("fallbacks", "context_window_fallbacks", "content_policy_fallbacks"):
        fallbacks = getattr(router, attr, None)
        if not isinstance(fallbacks, list):
            continue
        targets, _ = get_fallback_model_group_for_lookup_groups(
            fallbacks=fallbacks,
            lookup_groups=(model_group,),
        )
        for target in targets or ():
            name = fallback_target_model_name(target)
            if name:
                names.append(name)
    return tuple(dict.fromkeys(names))


def model_resource_keys(router: Any, models: Sequence[object], body: Mapping[str, Any]) -> list[str]:
    """Every model group a request can execute, fallbacks included.

    A client-supplied fallback or router override is refused: it could change
    the routed model after the decision. All configured fallbacks must be
    authorized too, so a provider failure cannot switch to an unshared model.
    """
    if "router_settings_override" in body:
        raise ResourceNotFound()
    if request_fallback_model_names(body):
        raise ResourceNotFound()
    if not models:
        raise ResourceNotFound()
    keys: list[str] = []
    for model in models:
        if not isinstance(model, str):
            raise ResourceNotFound()
        keys.append(resolve_model_key(router, model))
    for key in tuple(keys):
        for fallback in _fallback_model_names(router, key):
            keys.append(resolve_model_key(router, fallback))
    return list(dict.fromkeys(keys))


def _requested_models(
    request: Any, body: dict[str, Any], router: Any
) -> Sequence[object]:
    from litellm.proxy.common_utils.http_parsing_utils import (
        safe_get_request_headers,
        safe_get_request_query_params,
    )

    model = get_model_from_request(
        request_data=body,
        route=request.url.path,
        request_headers=safe_get_request_headers(request=request),
        request_query_params=safe_get_request_query_params(request=request),
        llm_router=router,
        request=request,
    )
    if model is None:
        raise ResourceNotFound()
    if isinstance(model, list):
        return model
    return (model,)


def agent_resource_key(request: Any, match: re.Match[str]) -> str:
    from litellm.proxy.agent_endpoints.agent_registry import global_agent_registry

    agent = global_agent_registry.get_agent_by_id(match.group(1))
    if agent is None:
        raise ResourceNotFound()
    name = getattr(agent, "agent_name", None)
    if not isinstance(name, str) or not name:
        raise ResourceNotFound()
    return name


def _mcp_header_names(request: Any) -> list[str]:
    raw = request.headers.get("x-mcp-servers") or request.headers.get("x-mcp-server")
    if not raw:
        return []
    return [name.strip() for name in raw.split(",") if name.strip()]


def mcp_resource_keys(request: Any) -> list[str]:
    from litellm.proxy._experimental.mcp_server.auth.user_api_key_auth_mcp import (
        MCPRequestHandler,
    )
    from litellm.proxy._experimental.mcp_server.mcp_server_manager import (
        global_mcp_server_manager,
    )

    names = MCPRequestHandler.extract_target_server_names_from_path(request.url.path)
    if not names:
        names = _mcp_header_names(request)
    if not names:
        raise ResourceNotFound()

    keys: list[str] = []
    for name in names:
        server = global_mcp_server_manager.get_mcp_server_by_name(name)
        if server is None:
            raise ResourceNotFound()
        key = getattr(server, "server_name", None) or getattr(server, "alias", None)
        if not isinstance(key, str) or not key:
            raise ResourceNotFound()
        keys.append(key)
    return list(dict.fromkeys(keys))


def _discovery_allowed(request: Any) -> bool:
    """Agent/MCP discovery is filtered by our wrappers; model listing by callback."""
    from resource_discovery import ensure_discovery_filters

    path = request.url.path
    if path in (AGENT_DISCOVERY, MCP_DISCOVERY):
        if not ensure_discovery_filters():
            raise ResourceUnavailable("discovery filter unavailable")
    if path == MCP_DISCOVERY:
        # These filters bypass the shared-scope server list by construction.
        params = getattr(request, "query_params", {}) or {}
        if "team_id" in params or "user_id" in params:
            raise ResourceNotFound()
    return True


async def enforce_resource_access(
    request: Any,
    *,
    subject_id: str,
    client_id: str,
    audience: str,
    body: dict[str, Any] | None = None,
    router: Any | None = None,
    policy: Any | None = None,
) -> SharingContext | None:
    """Resolve and authorize every resource a request executes.

    Returns None for discovery routes (filtered elsewhere) and raises
    `ResourceNotFound`/`ResourceUnavailable` for every denial path.
    """
    if not RESOURCE_SHARING_ENABLED:
        return None
    if body is None:
        body = await _read_body(request)
    kind = classify_route(request.url.path, request.method)
    if kind == DISCOVERY:
        _discovery_allowed(request)
        return None
    if kind == UNSUPPORTED:
        raise ResourceNotFound()

    if kind == MODEL:
        resolved_router = router or _router()
        keys = model_resource_keys(
            resolved_router, _requested_models(request, body, resolved_router), body
        )
    elif kind == WORKFLOW:
        match = A2A_ROUTE_RE.match(request.url.path)
        if match is None:
            raise ResourceNotFound()
        keys = [agent_resource_key(request, match)]
    else:
        keys = mcp_resource_keys(request)

    if not keys:
        raise ResourceNotFound()
    decisions: list[ResourceDecision] = []
    policy = policy or authorizer()
    for key in keys:
        decision = await policy.authorize(
            subject_id=subject_id,
            client_id=client_id,
            resource_type=kind,
            key=key,
            audience=audience,
            request_id=uuid.uuid4().hex,
        )
        if decision is None:
            raise ResourceNotFound()
        decisions.append(decision)

    team_ids = {decision.team_id for decision in decisions}
    if len(team_ids) != 1:
        # Several owners/plans cannot share one LiteLLM identity: fail closed.
        raise ResourceNotFound()
    return SharingContext(
        team_id=team_ids.pop(),
        subject_id=subject_id,
        client_id=client_id,
        audience=audience,
        resources=tuple(decisions),
    )


async def _hierarchical_router_settings(identity: UserAPIKeyAuth) -> Mapping[str, Any] | None:
    """Key/team router settings, the layer that can add fallbacks per team."""
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_config,
        proxy_logging_obj,
    )

    if proxy_config is None:
        return None
    try:
        return await proxy_config.get_hierarchical_router_settings(
            identity, prisma_client, proxy_logging_obj
        )
    except Exception as err:  # noqa: BLE001 - settings lookup failure is fail-closed
        raise ResourceUnavailable("router settings unavailable") from err


async def authorize_team_fallbacks(
    context: SharingContext,
    identity: UserAPIKeyAuth,
    *,
    router: Any | None = None,
    policy: Any | None = None,
    settings: Mapping[str, Any] | None = None,
) -> SharingContext:
    """Authorize fallbacks that only the key/team router settings add.

    Global router fallbacks are already covered before the team is known. This
    second pass closes the DB-configured layer: every reachable target must be
    allowed for the same owner-plan team as the primary resource.
    """
    if not any(item.resource_type == MODEL for item in context.resources):
        return context
    if settings is None:
        settings = await _hierarchical_router_settings(identity)
    if not settings:
        return context
    for attr in ("model_group_alias", "model_alias_map"):
        aliases = settings.get(attr)
        if isinstance(aliases, Mapping) and aliases:
            # A team/key alias could re-route after the primary decision.
            raise ResourceNotFound()

    resolved_router = router or _router()
    primary = tuple(item.key for item in context.resources if item.resource_type == MODEL)
    targets: list[str] = []
    for attr in ("fallbacks", "context_window_fallbacks", "content_policy_fallbacks"):
        fallbacks = settings.get(attr)
        if not isinstance(fallbacks, list):
            continue
        names, _ = get_fallback_model_group_for_lookup_groups(
            fallbacks=fallbacks,
            lookup_groups=primary,
        )
        for target in names or ():
            name = fallback_target_model_name(target)
            if name:
                targets.append(resolve_model_key(resolved_router, name))

    existing = {item.key for item in context.resources}
    decisions = list(context.resources)
    policy = policy or authorizer()
    for key in dict.fromkeys(targets):
        if key in existing:
            continue
        decision = await policy.authorize(
            subject_id=context.subject_id,
            client_id=context.client_id,
            resource_type=MODEL,
            key=key,
            audience=context.audience,
            request_id=uuid.uuid4().hex,
        )
        if decision is None or decision.team_id != context.team_id:
            raise ResourceNotFound()
        decisions.append(decision)
    return SharingContext(
        team_id=context.team_id,
        subject_id=context.subject_id,
        client_id=context.client_id,
        audience=context.audience,
        resources=tuple(decisions),
    )


def resource_not_found() -> ProxyException:
    return ProxyException(
        message="Resource not available",
        type="not_found_error",
        param=None,
        code=404,
    )


def resource_unavailable() -> ProxyException:
    return ProxyException(
        message="Resource policy unavailable; try again",
        type="service_unavailable",
        param="api_key",
        code=503,
    )
