"""Credit check and billing for the LiteLLM gateway, through the auth-service wallet.

Before a call, a user whose credit is exhausted is refused (HTTP 402). After a
successful call, the provider cost is reported to the wallet API, which prices it
(exchange rate and margin) and debits the user. Debits are spooled to disk before
being sent, so an auth-service outage or a restart never loses one: the request id
is the idempotency key, so retries can never charge twice.
"""

import asyncio
import json
import os
import time
import uuid
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException
from litellm._logging import verbose_proxy_logger as log
from litellm.integrations.custom_logger import CustomLogger


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} must be set (run `pnpm llm:setup`)")
    return value


AUTH_URL = _required_env("WALLET_AUTH_URL").rstrip("/")
CLIENT_ID = _required_env("WALLET_CLIENT_ID")
CLIENT_SECRET = _required_env("WALLET_CLIENT_SECRET")
SPOOL_DIR = Path(os.environ.get("WALLET_SPOOL_DIR", "/var/lib/circle-wallet"))
PENDING_DIR = SPOOL_DIR / "pending"
DEAD_DIR = SPOOL_DIR / "dead"
BALANCE_TTL_S = float(os.environ.get("WALLET_BALANCE_TTL_S", "5"))
# How long a previously fetched balance may be trusted when auth-service is down.
STALE_BALANCE_S = float(os.environ.get("WALLET_STALE_BALANCE_S", "60"))
RETRY_INTERVAL_S = float(os.environ.get("WALLET_RETRY_INTERVAL_S", "15"))
HTTP_TIMEOUT_S = 5.0
SCOPES = "wallet:read wallet:debit"
# Listing tools costs nothing; everything else a user calls is billable.
FREE_CALL_TYPES = {"list_mcp_tools"}

PENDING_DIR.mkdir(parents=True, exist_ok=True)
DEAD_DIR.mkdir(parents=True, exist_ok=True)


def _cost_decimal(cost: float) -> str:
    """Plain decimal string with at most 12 decimals; never zero for a positive cost."""
    d = Decimal(str(cost)).quantize(Decimal("1e-12"), rounding=ROUND_HALF_UP)
    if d <= 0:
        d = Decimal("1e-12")
    return format(d, "f")


class WalletLogger(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self._client: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        # user id -> (account, fetched at, needs refresh)
        self._balances: dict[str, tuple[dict[str, Any], float, bool]] = {}
        self._retry_task: asyncio.Task[None] | None = None
        # The module is normally imported while the server starts, inside its event
        # loop: start replaying spooled debits right away. Otherwise the first
        # request starts it.
        try:
            asyncio.get_running_loop()
            self._ensure_retry_loop()
        except RuntimeError:
            pass

    # ── auth-service client ──────────────────────────────────────────────────

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
        return self._client

    async def _access_token(self, force: bool = False) -> str:
        async with self._token_lock:
            if force or self._token is None or time.monotonic() > self._token_expires_at - 30:
                resp = await self._http().post(
                    f"{AUTH_URL}/api/auth/oauth2/token",
                    data={"grant_type": "client_credentials", "scope": SCOPES},
                    auth=(CLIENT_ID, CLIENT_SECRET),
                )
                resp.raise_for_status()
                body = resp.json()
                self._token = body["access_token"]
                self._token_expires_at = time.monotonic() + float(body.get("expires_in", 300))
            return self._token

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Call the wallet API, refreshing the machine token once if it was refused."""
        for attempt in (0, 1):
            token = await self._access_token(force=attempt == 1)
            resp = await self._http().request(
                method,
                f"{AUTH_URL}/api/internal/wallet{path}",
                headers={"Authorization": f"Bearer {token}"},
                **kwargs,
            )
            if resp.status_code != 401 or attempt == 1:
                return resp
        raise AssertionError("unreachable")

    # ── identity ─────────────────────────────────────────────────────────────

    @staticmethod
    def _identity(user_api_key_dict: Any) -> tuple[str, str] | None:
        """(user id, calling application) for an auth-service user, else None.

        Master key, admin UI session and LiteLLM virtual keys carry no `azp`: they
        are service traffic and are not billed per user.
        """
        user_id = getattr(user_api_key_dict, "user_id", None)
        metadata = getattr(user_api_key_dict, "metadata", None) or {}
        azp = metadata.get("azp")
        return (user_id, azp) if user_id and azp else None

    # ── before the call: is there credit? ────────────────────────────────────

    async def _account(self, user_id: str) -> dict[str, Any]:
        cached = self._balances.get(user_id)
        now = time.monotonic()
        if cached and not cached[2] and now - cached[1] < BALANCE_TTL_S:
            return cached[0]
        try:
            resp = await self._request("GET", f"/users/{user_id}")
            resp.raise_for_status()
        except (httpx.HTTPError, KeyError) as err:
            # Fail closed, except for a balance fetched moments ago.
            if cached and now - cached[1] < STALE_BALANCE_S:
                log.warning("wallet unreachable, using a recent balance: %s", err)
                return cached[0]
            log.error("wallet unreachable, refusing the call: %s", err)
            raise HTTPException(
                status_code=503,
                detail={"error": {"message": "Credit service unavailable, retry shortly.", "type": "wallet_unavailable", "code": "503"}},
            ) from None
        account = resp.json()
        self._balances[user_id] = (account, now, False)
        return account

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):  # noqa: ANN001
        identity = self._identity(user_api_key_dict)
        if identity is None or call_type in FREE_CALL_TYPES:
            return data
        self._ensure_retry_loop()
        account = await self._account(identity[0])
        if not account.get("canSpend"):
            raise HTTPException(
                status_code=402,
                detail={"error": {"message": "Insufficient credit. Top up your account to continue.", "type": "insufficient_credit", "code": "402"}},
            )
        return data

    # ── after the call: bill it ──────────────────────────────────────────────

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):  # noqa: ANN001
        await self._bill(kwargs)

    async def _bill(self, kwargs: dict[str, Any]) -> None:
        slo = kwargs.get("standard_logging_object") or {}
        meta = slo.get("metadata") or {}
        user_id = meta.get("user_api_key_user_id")
        azp = (meta.get("user_api_key_auth_metadata") or {}).get("azp")
        if not user_id or not azp:
            return

        cost = kwargs.get("response_cost")
        if cost is None:
            cost = slo.get("response_cost")
        call_id = kwargs.get("litellm_call_id") or slo.get("id")
        if not call_id:
            log.error("wallet: call without an id, cannot bill it safely")
            return
        if not cost or cost <= 0:
            log.debug("wallet: %s costs nothing, nothing to bill", call_id)
            return

        self._ensure_retry_loop()
        item = {
            "id": uuid.uuid4().hex,
            "userId": user_id,
            "attempts": 0,
            "body": {
                "costUsd": _cost_decimal(cost),
                "idempotencyKey": f"litellm:{call_id}",
                "applicationSlug": azp,
                "metadata": self._usage_metadata(slo, meta),
            },
        }
        # Written before the first attempt: a crash right after must not lose it.
        path = PENDING_DIR / f"{int(time.time() * 1000)}-{item['id']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(item))
        os.replace(tmp, path)
        await self._deliver(path)

    @staticmethod
    def _usage_metadata(slo: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
        """Raw quantities kept in the ledger so a charge can be audited and re-priced."""
        call_type = slo.get("call_type")
        if call_type == "call_mcp_tool":
            tool = meta.get("mcp_tool_call_metadata") or {}
            return {
                "kind": "mcp",
                "callType": call_type,
                "mcpServer": tool.get("mcp_server_name"),
                "tool": tool.get("name"),
            }
        return {
            "kind": "llm",
            "callType": call_type,
            "model": slo.get("model"),
            "promptTokens": slo.get("prompt_tokens"),
            "completionTokens": slo.get("completion_tokens"),
            "totalTokens": slo.get("total_tokens"),
        }

    # ── delivery with retry ──────────────────────────────────────────────────

    async def _deliver(self, path: Path) -> None:
        item = json.loads(path.read_text())
        user_id = item["userId"]
        try:
            resp = await self._request("POST", f"/users/{user_id}/usage", json=item["body"])
        except httpx.HTTPError as err:
            self._retry_later(path, item, f"unreachable: {err}")
            return

        if resp.status_code in (200, 201):
            path.unlink(missing_ok=True)
            # The balance changed: refresh it next time, but keep the last known
            # value for the case where the wallet is unreachable.
            known = self._balances.get(user_id)
            if known:
                self._balances[user_id] = (known[0], known[1], True)
            return
        # Transient or configuration problems: keep the debit and try again later.
        if resp.status_code in (401, 403, 408, 429) or resp.status_code >= 500:
            self._retry_later(path, item, f"HTTP {resp.status_code}")
            return
        # A request the wallet will never accept: set it aside for a human.
        log.error("wallet: debit %s refused (HTTP %s), moved to dead/: %s", item["body"]["idempotencyKey"], resp.status_code, resp.text[:300])
        os.replace(path, DEAD_DIR / path.name)

    def _retry_later(self, path: Path, item: dict[str, Any], reason: str) -> None:
        item["attempts"] += 1
        path.write_text(json.dumps(item))
        log.warning("wallet: debit %s not delivered (%s), attempt %d", item["body"]["idempotencyKey"], reason, item["attempts"])

    def _ensure_retry_loop(self) -> None:
        if self._retry_task is None or self._retry_task.done():
            self._retry_task = asyncio.ensure_future(self._retry_loop())

    async def _retry_loop(self) -> None:
        while True:
            for path in sorted(PENDING_DIR.glob("*.json")):
                try:
                    item = json.loads(path.read_text())
                    # Back off with the number of failed attempts, up to 5 minutes.
                    age = time.time() - path.stat().st_mtime
                    if item["attempts"] > 0 and age < min(RETRY_INTERVAL_S * 2 ** (item["attempts"] - 1), 300):
                        continue
                    await self._deliver(path)
                except Exception as err:  # noqa: BLE001 - one bad file must not stop the loop
                    log.error("wallet: retry of %s failed: %s", path.name, err)
            await asyncio.sleep(RETRY_INTERVAL_S)


wallet_logger = WalletLogger()
