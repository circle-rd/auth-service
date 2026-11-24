"""Owner-attributed usage reporting for gateway resources.

This is a distinct pipeline from `circle_wallet.py`: it records gross provider
usage per resource owner, never a wallet debit or balance change. Events are
spooled before delivery and retried with a stable, gateway-generated id, so an
auth-service outage cannot lose accounting data and redelivery cannot duplicate
a row.

Attribution comes only from the entitlement context that `custom_auth.py` stores
on the authenticated identity. Nothing from the request body, the user's own
metadata, or an `x-litellm-call-id` header is trusted.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

import httpx
from litellm._logging import verbose_proxy_logger as log
from litellm.integrations.custom_logger import CustomLogger

from entitlements import USAGE_METADATA_KEY

AUTH_URL = (os.environ.get("WALLET_AUTH_URL") or "").rstrip("/")
CLIENT_ID = os.environ.get("WALLET_CLIENT_ID") or ""
CLIENT_SECRET = os.environ.get("WALLET_CLIENT_SECRET") or ""
USAGE_SCOPE = os.environ.get("RESOURCE_USAGE_SCOPE", "resources:usage:write")
# The LiteLLM container mounts WALLET_SPOOL_DIR as a persistent volume. Keep the
# usage spool in a subdirectory so it survives recreation and never collides with
# the wallet's own pending/dead directories.
WALLET_SPOOL_DIR = os.environ.get("WALLET_SPOOL_DIR", "/var/lib/circle-wallet")
SPOOL_DIR = Path(
    os.environ.get("RESOURCE_USAGE_SPOOL_DIR")
    or str(Path(WALLET_SPOOL_DIR) / "resource-usage")
)
PENDING_DIR = SPOOL_DIR / "pending"
DEAD_DIR = SPOOL_DIR / "dead"
BACKGROUND_RETRY = os.environ.get("RESOURCE_USAGE_BACKGROUND_RETRY", "1") != "0"
RETRY_INTERVAL_S = float(os.environ.get("RESOURCE_USAGE_RETRY_INTERVAL_S", "15"))
HTTP_TIMEOUT_S = float(os.environ.get("RESOURCE_USAGE_HTTP_TIMEOUT_S", "5"))
MAX_ATTEMPT_BACKOFF_S = 300.0

MODEL = "model"
MCP_CALL_TYPE = "call_mcp_tool"

if not AUTH_URL or not CLIENT_ID or not CLIENT_SECRET:
    raise RuntimeError(
        "WALLET_AUTH_URL, WALLET_CLIENT_ID and WALLET_CLIENT_SECRET are required"
    )


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


def _resource_index(
    resources: Sequence[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    index: dict[str, Mapping[str, Any]] = {}
    ambiguous: set[str] = set()
    parents: dict[str, list[Mapping[str, Any]]] = {}
    for resource in resources:
        name = resource.get("name")
        if isinstance(name, str) and name:
            if name in index:
                ambiguous.add(name)
            else:
                index[name] = resource
        parent = resource.get("parentName")
        if isinstance(parent, str) and parent:
            parents.setdefault(parent, []).append(resource)
    for name in ambiguous:
        index.pop(name, None)
    for parent, children in parents.items():
        # A parent alias is only safe when it names no resource itself and
        # exactly one child claims it; otherwise the owner is ambiguous.
        if parent not in index and parent not in ambiguous and len(children) == 1:
            index[parent] = children[0]
    return index


def select_executed_resource(
    payload: Mapping[str, Any],
    metadata: Mapping[str, Any],
    resources: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """The entitlement resource this provider call actually executed.

    `model_group` carries the fallback target on a fallback attempt. MCP calls
    name their server and optionally their tool. Anything ambiguous with more
    than one resource is skipped rather than attributed to the wrong owner.
    """
    index = _resource_index(resources)
    if not index:
        return None

    model_group = payload.get("model_group")
    if isinstance(model_group, str) and model_group in index:
        return index[model_group]

    if payload.get("call_type") == MCP_CALL_TYPE:
        tool = metadata.get("mcp_tool_call_metadata") or {}
        if isinstance(tool, Mapping):
            name = tool.get("mcp_server_name")
            if isinstance(name, str) and name in index:
                candidates = [
                    resource
                    for resource in resources
                    if resource.get("parentName") == name
                ]
                tool_name = tool.get("mcp_tool_name") or tool.get("name")
                if isinstance(tool_name, str):
                    for resource in candidates:
                        if resource.get("name") == tool_name:
                            return resource
                if len(candidates) == 1:
                    return candidates[0]
                # Several tools share the server name: only an explicit
                # server-level resource is unambiguous, otherwise skip.
                return next(
                    (
                        resource
                        for resource in resources
                        if resource.get("name") == name
                        and not resource.get("parentName")
                    ),
                    None,
                )

    if len(resources) == 1:
        return resources[0]

    model = payload.get("model")
    if isinstance(model, str) and model in index:
        return index[model]
    return None


def _usage_values(payload: Mapping[str, Any], kind: str, failed: bool):
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
    if not failed and kind == MODEL and not has_usage:
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

    decision_id = context.get("decisionId")
    resources = context.get("resources")
    if not isinstance(decision_id, str) or not decision_id:
        return None
    if not isinstance(resources, list):
        return None

    resource = select_executed_resource(payload, metadata, resources)
    if resource is None:
        return None
    resource_id = resource.get("resourceId")
    uri = resource.get("uri")
    kind = resource.get("kind")
    name = resource.get("name")
    parent = resource.get("parentName", "")
    if not all(
        isinstance(value, str) and value
        for value in (resource_id, uri, kind, name)
    ):
        return None
    if not isinstance(parent, str):
        parent = ""

    values = _usage_values(payload, kind, failed)
    if values is None:
        return None

    trace_id = payload.get("trace_id") or ""
    call_id = payload.get("litellm_call_id") or payload.get("id")
    if not isinstance(call_id, str) or not call_id:
        call_id = uuid.uuid4().hex
    start = payload.get("startTime")
    seed = f"{trace_id}|{call_id}|{resource_id}|{start}"
    request_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()

    # The decision must have been in force when the request started.
    if not isinstance(start, (int, float)) or isinstance(start, bool):
        return None
    started = datetime.fromtimestamp(float(start), tz=timezone.utc)
    moment = now or datetime.now(timezone.utc)
    occurred = payload.get("endTime")
    if isinstance(occurred, (int, float)):
        moment = datetime.fromtimestamp(float(occurred), tz=timezone.utc)
    return {
        "decisionId": decision_id,
        "startedAt": _iso(started),
        "resourceId": resource_id,
        "resourceUri": uri,
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
        self._retry_thread: threading.Thread | None = None
        self._directories_ready = False
        if BACKGROUND_RETRY:
            self._ensure_retry_loop()

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
                    f"{AUTH_URL}/api/auth/oauth2/token",
                    data={"grant_type": "client_credentials", "scope": USAGE_SCOPE},
                    auth=(CLIENT_ID, CLIENT_SECRET),
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
                f"{AUTH_URL}/api/internal/gateway/usage",
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
            if BACKGROUND_RETRY:
                self._ensure_retry_loop()
        except Exception as err:  # noqa: BLE001 - accounting must not fail a response
            log.error("resource usage: could not spool an event: %s", type(err).__name__)

    def _start_retry_thread(self) -> None:
        if self._retry_thread is not None and self._retry_thread.is_alive():
            return
        self._retry_thread = threading.Thread(
            target=self._run_retry_thread,
            name="resource-usage-retry",
            daemon=True,
        )
        self._retry_thread.start()

    def _run_retry_thread(self) -> None:
        try:
            asyncio.run(self._retry_loop())
        except Exception as err:  # noqa: BLE001 - a dead retry loop is reported
            log.error(
                "resource usage: retry loop stopped: %s", type(err).__name__
            )

    def _ensure_retry_loop(self) -> None:
        if self._retry_thread is not None and self._retry_thread.is_alive():
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # Imported before the server loop exists: own a daemon loop so
            # events spooled by a previous process are delivered at startup.
            self._start_retry_thread()
            return
        if self._retry_task is None or self._retry_task.done():
            self._retry_task = asyncio.ensure_future(self._retry_loop())

    async def _retry_loop(self) -> None:
        while True:
            for path in sorted(PENDING_DIR.glob("*.json")):
                try:
                    item = json.loads(path.read_text())
                    age = time.time() - path.stat().st_mtime
                    if item["attempts"] > 0 and age < min(
                        RETRY_INTERVAL_S * 2 ** min(item["attempts"] - 1, 16),
                        MAX_ATTEMPT_BACKOFF_S,
                    ):
                        continue
                    await self._deliver(path)
                except Exception as err:  # noqa: BLE001 - one bad file must not stop the loop
                    log.error(
                        "resource usage: retry of %s failed: %s",
                        path.name,
                        type(err).__name__,
                    )
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
        # A crash mid-write must not leave an unparseable event in place.
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(item))
        os.replace(tmp, path)
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


resource_usage_logger = ResourceUsageLogger()
