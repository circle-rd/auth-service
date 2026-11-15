"""Owner-usage callback construction, without a proxy, network or secret."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

for name, value in {
    "JWT_PUBLIC_KEY_URL": "https://auth.test/api/auth/jwks",
    "JWT_ISSUER": "https://auth.test",
    "JWT_AUDIENCE": "https://llm.test",
    "LITELLM_MASTER_KEY": "sk-master",
    "LITELLM_SALT_KEY": "salt",
    "WALLET_AUTH_URL": "https://auth.test",
    "WALLET_CLIENT_ID": "litellm-wallet",
    "WALLET_CLIENT_SECRET": "secret",
    "GATEWAY_ENTITLEMENTS_URL": "https://auth.test",
    "RESOURCE_USAGE_SPOOL_DIR": tempfile.mkdtemp(prefix="resource-usage-test-"),
    "RESOURCE_USAGE_BACKGROUND_RETRY": "0",
}.items():
    os.environ.setdefault(name, value)

sys.path.insert(0, str(Path(os.environ.get("GATEWAY_DIR", "/gateway"))))

import resource_usage  # noqa: E402
from entitlements import USAGE_METADATA_KEY  # noqa: E402


def resource(name, resource_id, kind="model", parent=""):
    return {
        "resourceId": resource_id,
        "uri": f"llm://acme/{name}",
        "scheme": "llm" if kind == "model" else "mcp",
        "kind": kind,
        "name": name,
        "parentName": parent,
        "applicationSlug": "owner",
        "ownerType": "user",
        "ownerId": "owner-1",
    }


def payload(
    *,
    resources=None,
    model_group="owner/model",
    model="deployment/model",
    call_type="completion",
    cost=0.01,
    total=10,
    prompt=6,
    completion=4,
    trace_id="trace-1",
    call_id="call-1",
    end_time=1000.0,
    mcp_server=None,
    mcp_tool=None,
):
    meta = {
        "user_api_key_auth_metadata": {
            USAGE_METADATA_KEY: {
                "subjectId": "subject-a",
                "clientId": "client-a",
                "resources": resources
                if resources is not None
                else [resource("owner/model", "resource-1")],
            }
        }
    }
    if mcp_server:
        meta["mcp_tool_call_metadata"] = {"mcp_server_name": mcp_server}
        if mcp_tool:
            meta["mcp_tool_call_metadata"]["mcp_tool_name"] = mcp_tool
    return {
        "standard_logging_object": {
            "id": call_id,
            "trace_id": trace_id,
            "litellm_call_id": call_id,
            "call_type": call_type,
            "model": model,
            "model_group": model_group,
            "response_cost": cost,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
            "startTime": 900.0,
            "endTime": end_time,
            "metadata": meta,
        }
    }


class BuildEvent(unittest.TestCase):
    def test_success_is_attributed_to_the_entitlement_resource(self) -> None:
        event = resource_usage.build_event(payload(), failed=False)
        self.assertIsNotNone(event)
        self.assertEqual(event["subjectId"], "subject-a")
        self.assertEqual(event["clientId"], "client-a")
        self.assertEqual(event["resourceId"], "resource-1")
        self.assertEqual(event["resourceUri"], "llm://acme/owner/model")
        self.assertEqual(event["usageSource"], "provider")
        self.assertEqual(event["totalTokens"], 10)
        self.assertEqual(event["costUsd"], "0.010000000000000000")
        self.assertRegex(event["requestId"], r"^[a-f0-9]{64}$")
        self.assertTrue(event["occurredAt"].endswith("Z"))

    def test_same_callback_yields_the_same_idempotency_id(self) -> None:
        first = resource_usage.build_event(payload(), failed=False)
        second = resource_usage.build_event(payload(), failed=False)
        self.assertEqual(first["requestId"], second["requestId"])

    def test_a_fallback_attempt_gets_its_own_event(self) -> None:
        resources = [
            resource("owner/model", "resource-primary"),
            resource("owner/fallback", "resource-fallback"),
        ]
        primary = resource_usage.build_event(
            payload(resources=resources, model_group="owner/model", call_id="call-primary"),
            failed=False,
        )
        fallback = resource_usage.build_event(
            payload(resources=resources, model_group="owner/fallback", call_id="call-fallback"),
            failed=False,
        )
        self.assertEqual(primary["resourceId"], "resource-primary")
        self.assertEqual(fallback["resourceId"], "resource-fallback")
        self.assertNotEqual(primary["requestId"], fallback["requestId"])

    def test_ambiguous_multi_resource_call_is_skipped(self) -> None:
        resources = [
            resource("owner/model", "resource-primary"),
            resource("owner/fallback", "resource-fallback"),
        ]
        self.assertIsNone(
            resource_usage.build_event(
                payload(resources=resources, model_group="unknown/model"),
                failed=False,
            )
        )

    def test_single_resource_is_used_when_the_callback_has_no_group(self) -> None:
        event = resource_usage.build_event(payload(model_group=None), failed=False)
        self.assertEqual(event["resourceId"], "resource-1")

    def test_successful_model_call_without_usage_creates_no_event(self) -> None:
        self.assertIsNone(
            resource_usage.build_event(
                payload(cost=0, total=0, prompt=0, completion=0), failed=False
            )
        )

    def test_failure_without_usage_creates_no_event(self) -> None:
        self.assertIsNone(
            resource_usage.build_event(
                payload(cost=0, total=0, prompt=0, completion=0), failed=True
            )
        )

    def test_partial_stream_failure_with_cost_is_recorded(self) -> None:
        event = resource_usage.build_event(payload(cost=0.002, total=3), failed=True)
        self.assertIsNotNone(event)
        self.assertEqual(event["usageSource"], "provider")
        self.assertEqual(event["totalTokens"], 3)

    def test_mcp_server_is_matched_by_name(self) -> None:
        event = resource_usage.build_event(
            payload(
                resources=[resource("server-x", "resource-mcp", "mcp_server")],
                call_type="call_mcp_tool",
                model_group=None,
                cost=0,
                total=0,
                prompt=0,
                completion=0,
                mcp_server="server-x",
            ),
            failed=False,
        )
        self.assertIsNotNone(event)
        self.assertEqual(event["resourceId"], "resource-mcp")
        self.assertEqual(event["usageSource"], "unsupported")
        self.assertIsNone(event["costUsd"])

    def test_mcp_tool_is_matched_by_parent_and_tool_name(self) -> None:
        event = resource_usage.build_event(
            payload(
                resources=[
                    resource("other-tool", "resource-other", "mcp_tool", "other"),
                    resource("search", "resource-tool", "mcp_tool", "server-x"),
                ],
                call_type="call_mcp_tool",
                model_group=None,
                cost=0.001,
                total=2,
                mcp_server="server-x",
                mcp_tool="search",
            ),
            failed=False,
        )
        self.assertIsNotNone(event)
        self.assertEqual(event["resourceId"], "resource-tool")

    def test_ambiguous_mcp_server_without_tool_is_skipped(self) -> None:
        event = resource_usage.build_event(
            payload(
                resources=[
                    resource("search", "resource-a", "mcp_tool", "server-x"),
                    resource("fetch", "resource-b", "mcp_tool", "server-x"),
                ],
                call_type="call_mcp_tool",
                model_group=None,
                cost=0,
                total=0,
                prompt=0,
                completion=0,
                mcp_server="server-x",
            ),
            failed=False,
        )
        self.assertIsNone(event)

    def test_unverified_identity_creates_no_event(self) -> None:
        raw = payload()
        raw["standard_logging_object"]["metadata"] = {}
        self.assertIsNone(resource_usage.build_event(raw, failed=False))

    def test_user_supplied_call_id_is_not_the_authority(self) -> None:
        first = resource_usage.build_event(payload(call_id="user-chosen"), failed=False)
        second = resource_usage.build_event(
            payload(call_id="user-chosen", trace_id="other"), failed=False
        )
        self.assertNotEqual(first["requestId"], second["requestId"])


class Spool(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.pending = Path(tempfile.mkdtemp(prefix="usage-pending-"))
        self.dead = Path(tempfile.mkdtemp(prefix="usage-dead-"))
        self.previous = (
            resource_usage.PENDING_DIR,
            resource_usage.DEAD_DIR,
        )
        resource_usage.PENDING_DIR = self.pending
        resource_usage.DEAD_DIR = self.dead
        self.logger = resource_usage.ResourceUsageLogger()
        self.logger._directories_ready = True
        self.logger._ensure_retry_loop = lambda: None

    def tearDown(self) -> None:
        (
            resource_usage.PENDING_DIR,
            resource_usage.DEAD_DIR,
        ) = self.previous

    async def test_event_is_spooled_before_delivery(self) -> None:
        await self.logger.async_log_success_event(payload(), None, None, None)
        files = list(self.pending.glob("*.json"))
        self.assertEqual(len(files), 1)
        item = json.loads(files[0].read_text())
        self.assertEqual(item["attempts"], 0)
        self.assertEqual(item["body"]["resourceId"], "resource-1")

    async def test_capture_failure_never_raises(self) -> None:
        self.pending.rmdir()
        self.pending.write_text("not a directory")
        await self.logger.async_log_success_event(payload(), None, None, None)

    async def test_delivery_success_removes_the_spooled_event(self) -> None:
        await self.logger.async_log_success_event(payload(), None, None, None)
        path = next(self.pending.glob("*.json"))

        async def delivered(body):
            return type("Response", (), {"status_code": 201})()

        self.logger._request = delivered
        await self.logger._deliver(path)
        self.assertFalse(path.exists())

    async def test_transient_failure_keeps_the_event_for_retry(self) -> None:
        await self.logger.async_log_success_event(payload(), None, None, None)
        path = next(self.pending.glob("*.json"))

        async def unavailable(body):
            return type("Response", (), {"status_code": 503})()

        self.logger._request = unavailable
        await self.logger._deliver(path)
        self.assertTrue(path.exists())
        self.assertEqual(json.loads(path.read_text())["attempts"], 1)


if __name__ == "__main__":
    unittest.main()
