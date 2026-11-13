"""Owner-attributed usage reporting for shared resources.

This is a distinct pipeline from `circle_wallet.py`: it records gross provider
usage per owner application, never a wallet debit or balance change. Events are
spooled before delivery and retried with a stable, gateway-generated id, so an
auth-service outage cannot lose accounting data and redelivery cannot duplicate
a row. The callback never changes the user response: every failure is contained
and left for the durable retry loop.

Attribution comes only from the verified `SharingContext` that
`custom_auth.py` stores in the internal identity metadata during resource
authorization. Nothing from the request body, the user's own metadata, or an
`x-litellm-call-id` header is trusted.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import time
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

import httpx
from litellm._logging import verbose_proxy_logger as log
from litellm.integrations.custom_logger import CustomLogger

from resource_sharing import (
    RESOURCE_AUTH_URL,
    RESOURCE_CLIENT_ID,
    RESOURCE_CLIENT_SECRET,
    RESOURCE_SHARING_ENABLED,
    USAGE_METADATA_KEY,
)

USAGE_SCOPE = os.environ.get("RESOURCE_USAGE_SCOPE", "resources:usage:write")
USAGE_CLIENT_ID = os.environ.get("RESOURCE_USAGE_CLIENT_ID") or RESOURCE_CLIENT_ID
USAGE_CLIENT_SECRET = (
    os.environ.get("RESOURCE_USAGE_CLIENT_SECRET") or RESOURCE_CLIENT_SECRET
)
SPOOL_DIR = Path(
    os.environ.get("RESOURCE_USAGE_SPOOL_DIR", "/var/lib/circle-resource-usage")
)
PENDING_DIR = SPOOL_DIR / "pending"
DEAD_DIR = SPOOL_DIR / "dead"
RETRY_INTERVAL_S = float(os.environ.get("RESOURCE_USAGE_RETRY_INTERVAL_S", "15"))
HTTP_TIMEOUT_S = float(os.environ.get("RESOURCE_USAGE_HTTP_TIMEOUT_S", "5"))
MAX_ATTEMPT_BACKOFF_S = 300.0

MODEL = "model"
WORKFLOW = "workflow"
MCP_AGENT = "mcp_agent"
MCP_CALL_TYPE = "call_mcp_tool"


def _decimal(value: Any) -> str:
    """Plain decimal string with at most 18 decimals, including zero."""
    parsed = Decimal(str(value)).quantize(Decimal("1e-18"), rounding=ROUND_HALF_UP)
    if parsed < 0:
        raise ValueError("provider cost must not be negative")
    return format(parsed, "f")


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _resource_index(resources: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    index: dict[str, Mapping[str, Any]] = {}
    for resource in resources:
        key = resource.get("key")
        if isinstance(key, str) and key:
            index[key] = resource
    return index


def select_executed_resource(
    payload: Mapping[str, Any],
    metadata: Mapping[str, Any],
    resources: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """The authorized resource this provider call actually executed.

    `model_group` carries the fallback target on a fallback attempt. MCP calls
    name their server. Anything ambiguous with more than one authorized
    resource is skipped rather than attributed to the wrong owner.
    """
    index = _resource_index(resources)
    if not index:
        return None

    model_group = payload.get("model_group")
    if isinstance(model_group, str) and model_group in index:
        return index[model_group]

    if payload.get("call_type") == MCP_CALL_TYPE:
        tool = metadata.get("mcp_tool_call_metadata") or {}
        name = tool.get("mcp_server_name") if isinstance(tool, Mapping) else None
        if isinstance(name, str) and name in index:
            return index[name]

    if len(index) == 1:
        return next(iter(index.values()))

    model = payload.get("model")
    if isinstance(model, str) and model:
        try:
            from resource_routing import _router, resolve_model_key

            key = resolve_model_key(_router(), model)
        except Exception:  # noqa: BLE001 - attribution is best-effort here
            return None
        if key in index:
            return index[key]
    return None


def _usage_values(payload: Mapping[str, Any], resource_type: str, failed: bool):
    cost = payload.get("response_cost")
    total = payload.get("total_tokens")
    prompt = payload.get("prompt_tokens")
    completion = payload.get("completion_tokens")
    has_cost = (
        isinstance(cost, (int, float)) and math.isfinite(cost) and cost > 0
    )
    has_tokens = isinstance(total, int) and total > 0
    has_usage = has_cost or has_tokens

    if failed and not has_usage:
        return None
    if not failed and resource_type == MODEL and not has_usage:
        # A successful model call with no provider cost or tokens is not
        # billable usage; creating a zero row would imply the opposite.
        return None

    if has_usage:
        return {
            "usageSource": "provider",
            "costUsd": _decimal(cost if isinstance(cost, (int, float)) else 0),
            "promptTokens": prompt if isinstance(prompt, int) and prompt >= 0 else None,
            "completionTokens": (
                completion if isinstance(completion, int) and completion >= 0 else None
            ),
            "totalTokens": total if isinstance(total, int) and total >= 0 else None,
        }
    return {
        "usageSource": "unsupported",
        "costUsd": None,
        "promptTokens": None,
        "completionTokens": None,
        "totalTokens": None,
    }


def build_event(
    kwargs: Mapping[str, Any],
    *,
    failed: bool,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Build a usage event from a LiteLLM callback, or None when not billable."""
    payload = kwargs.get("standard_logging_object") or {}
    if not isinstance(payload, Mapping):
        return None
    metadata = payload.get("metadata") or {}
    if not isinstance(metadata, Mapping):
        return None
    auth_metadata = metadata.get("user_api_key_auth_metadata") or {}
    if not isinstance(auth_metadata, Mapping):
        return None
    context = auth_metadata.get(USAGE_METADATA_KEY)
    if not isinstance(context, Mapping):
        return None

    subject = context.get("subjectId")
    client = context.get("clientId")
    resources = context.get("resources")
    if not isinstance(subject, str) or not subject:
        return None
    if not isinstance(client, str) or not client:
        return None
    if not isinstance(resources, list):
        return None

    resource = select_executed_resource(payload, metadata, resources)
    if resource is None:
        return None
    resource_id = resource.get("resourceId")
    resource_type = resource.get("resourceType")
    resource_key = resource.get("key")
    plan_name = resource.get("planName")
    if not all(
        isinstance(value, str) and value
        for value in (resource_id, resource_type, resource_key, plan_name)
    ):
        return None

    values = _usage_values(payload, resource_type, failed)
    if values is None:
        return None

    trace_id = payload.get("trace_id") or ""
    call_id = payload.get("litellm_call_id") or payload.get("id")
    if not isinstance(call_id, str) or not call_id:
        call_id = uuid.uuid4().hex
    start = payload.get("startTime")
    seed = f"{trace_id}|{call_id}|{resource_key}|{start}"
    request_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()

    moment = now or datetime.now(timezone.utc)
    occurred = payload.get("endTime")
    if isinstance(occurred, (int, float)):
        moment = datetime.fromtimestamp(float(occurred), tz=timezone.utc)
    return {
        "subjectId": subject,
        "clientId": client,
        "resourceId": resource_id,
        "resourceType": resource_type,
        "resourceKey": resource_key,
        "planName": plan_name,
        "requestId": request_id,
        "occurredAt": _iso(moment),
        **values,
    }


class ResourceUsageLogger(CustomLogger):
    """Spool and deliver gross owner usage without touching the wallet."""

    def __init__(self) -> None:
        super().__init__()
        self._client: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._retry_task: asyncio.Task[None] | None = None
        self._directories_ready = False
        if not RESOURCE_SHARING_ENABLED:
            return
        try:
            asyncio.get_running_loop()
            self._ensure_retry_loop()
        except RuntimeError:
            pass

    def _ensure_directories(self) -> None:
        if self._directories_ready:
            return
        PENDING_DIR.mkdir(parents=True, exist_ok=True)
        DEAD_DIR.mkdir(parents=True, exist_ok=True)
        self._directories_ready = True

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
        return self._client

    async def _access_token(self, force: bool = False) -> str:
        async with self._token_lock:
            if (
                force
                or self._token is None
                or time.monotonic() > self._token_expires_at - 30
            ):
                resp = await self._http().post(
                    f"{RESOURCE_AUTH_URL}/api/auth/oauth2/token",
                    data={"grant_type": "client_credentials", "scope": USAGE_SCOPE},
                    auth=(USAGE_CLIENT_ID, USAGE_CLIENT_SECRET),
                )
                resp.raise_for_status()
                body = resp.json()
                self._token = body["access_token"]
                self._token_expires_at = time.monotonic() + float(
                    body.get("expires_in", 300)
                )
            return self._token

    async def _request(self, body: Mapping[str, Any]) -> httpx.Response:
        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            resp = await self._http().post(
                f"{RESOURCE_AUTH_URL}/api/internal/gateway/usage",
                headers={"Authorization": f"Bearer {token}"},
                json=body,
            )
            if resp.status_code != 401 or attempt == 1:
                return resp
        raise AssertionError("unreachable")

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):  # noqa: ANN001
        self._capture(kwargs, failed=False)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):  # noqa: ANN001
        self._capture(kwargs, failed=True)

    def _capture(self, kwargs: Mapping[str, Any], *, failed: bool) -> None:
        """Spool synchronously; never raise into the request path."""
        if not RESOURCE_SHARING_ENABLED:
            return
        try:
            event = build_event(kwargs, failed=failed)
            if event is None:
                return
            self._ensure_directories()
            item = {"id": event["requestId"], "attempts": 0, "body": event}
            path = PENDING_DIR / f"{int(time.time() * 1000)}-{item['id']}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(item))
            os.replace(tmp, path)
            self._ensure_retry_loop()
        except Exception as err:  # noqa: BLE001 - accounting must not fail a response
            log.error("resource usage: could not spool an event: %s", type(err).__name__)

    def _ensure_retry_loop(self) -> None:
        if self._retry_task is None or self._retry_task.done():
            self._retry_task = asyncio.ensure_future(self._retry_loop())

    async def _retry_loop(self) -> None:
        while True:
            for path in sorted(PENDING_DIR.glob("*.json")):
                try:
                    item = json.loads(path.read_text())
                    age = time.time() - path.stat().st_mtime
                    if item["attempts"] > 0 and age < min(
                        RETRY_INTERVAL_S * 2 ** (item["attempts"] - 1),
                        MAX_ATTEMPT_BACKOFF_S,
                    ):
                        continue
                    await self._deliver(path)
                except Exception as err:  # noqa: BLE001 - one bad file must not stop the loop
                    log.error("resource usage: retry of %s failed: %s", path.name, type(err).__name__)
            self._report_backlog()
            await asyncio.sleep(RETRY_INTERVAL_S)

    async def _deliver(self, path: Path) -> None:
        item = json.loads(path.read_text())
        try:
            resp = await self._request(item["body"])
        except httpx.HTTPError as err:
            self._retry_later(path, item, f"unreachable: {type(err).__name__}")
            return

        if resp.status_code in (200, 201):
            path.unlink(missing_ok=True)
            return
        if resp.status_code in (401, 403, 408, 429) or resp.status_code >= 500:
            self._retry_later(path, item, f"HTTP {resp.status_code}")
            return
        log.error(
            "resource usage: event %s refused (HTTP %s), moved to dead/",
            item["body"].get("requestId"),
            resp.status_code,
        )
        os.replace(path, DEAD_DIR / path.name)

    def _retry_later(self, path: Path, item: dict[str, Any], reason: str) -> None:
        item["attempts"] += 1
        path.write_text(json.dumps(item))
        log.warning(
            "resource usage: event %s not delivered (%s), attempt %d",
            item["body"].get("requestId"),
            reason,
            item["attempts"],
        )

    @staticmethod
    def _report_backlog() -> None:
        pending = [
            p
            for p in PENDING_DIR.glob("*.json")
            if time.time() - p.stat().st_mtime > 2 * RETRY_INTERVAL_S
        ]
        dead = list(DEAD_DIR.glob("*.json"))
        if dead:
            log.error(
                "resource usage: %d event(s) refused for good are waiting in %s",
                len(dead),
                DEAD_DIR,
            )
        if pending:
            oldest = max(time.time() - p.stat().st_mtime for p in pending)
            log.warning(
                "resource usage: %d event(s) not yet delivered, oldest unchanged for %ds",
                len(pending),
                oldest,
            )


if RESOURCE_SHARING_ENABLED and not (USAGE_CLIENT_ID and USAGE_CLIENT_SECRET):
    raise RuntimeError(
        "RESOURCE_SHARING_ENABLED requires resource usage client credentials"
    )

resource_usage_logger = ResourceUsageLogger()
