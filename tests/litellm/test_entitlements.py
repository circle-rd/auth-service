"""Entitlement resolver: parsing, cache and fail-closed behaviour."""

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

for name, value in {
    "GATEWAY_ENTITLEMENTS_URL": "https://auth.test",
    "WALLET_CLIENT_ID": "litellm-wallet",
    "WALLET_CLIENT_SECRET": "secret",
}.items():
    os.environ.setdefault(name, value)

sys.path.insert(0, str(Path(os.environ.get("GATEWAY_DIR", "/gateway"))))

import entitlements  # noqa: E402


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("http error")


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if url.endswith("/oauth2/token"):
            return FakeResponse(200, {"access_token": "token", "expires_in": 300})
        return self.responses.pop(0)


NOW = 1_700_000_000.0


def body(
    models=("gpt-x",),
    agents=("analyst",),
    subject="user-1",
    client="acme",
    ttl=60,
    key_id=None,
):
    expires = datetime.fromtimestamp(NOW + ttl, tz=timezone.utc).isoformat()
    payload = {
        "subjectId": subject,
        "clientId": client,
        "decisionId": "decision-1",
        "expiresAt": expires,
        "models": list(models),
        "agents": list(agents),
        "mcpServers": ["server-x"],
        "mcpToolPermissions": {"server-x": ["search"]},
        "resources": [
            {
                "resourceId": "r1",
                "uri": "llm://acme/gpt-x",
                "scheme": "llm",
                "kind": "model",
                "name": "gpt-x",
                "parentName": "",
                "applicationSlug": "acme",
                "ownerType": "application",
            }
        ],
    }
    if key_id is not None:
        payload["keyId"] = key_id
    return payload


def entitlement_calls(client):
    return [c for c in client.calls if c[1].endswith("/gateway/entitlements")]


class Resolver(unittest.IsolatedAsyncioTestCase):
    def resolver(self, responses, clock=None):
        client = FakeClient(responses)
        now = clock or (lambda: 1000.0)
        return (
            entitlements.EntitlementResolver(
                client=client,
                clock=now,
                wall_clock=lambda: NOW + (now() - 1000.0),
            ),
            client,
        )

    async def test_forwards_the_token_and_caches_per_token(self) -> None:
        now = [1000.0]
        resolver, client = self.resolver(
            [FakeResponse(200, body()), FakeResponse(200, body(models=("o",)))],
            clock=lambda: now[0],
        )
        first = await resolver.resolve("token-a", "user-1", "acme")
        self.assertEqual(first.models, ("gpt-x",))
        self.assertEqual(first.decision_id, "decision-1")
        self.assertEqual(first.mcp_tool_permissions, {"server-x": ("search",)})
        self.assertEqual(first.resources[0].parent_name, "")
        call = entitlement_calls(client)[0]
        self.assertEqual(call[2]["json"], {"token": "token-a"})
        # The caller states neither a person nor an application.
        self.assertNotIn("params", call[2])

        now[0] += 10
        again = await resolver.resolve("token-a", "user-1", "acme")
        self.assertEqual(again.models, ("gpt-x",))
        self.assertEqual(len(entitlement_calls(client)), 1)

        other = await resolver.resolve("token-b", "user-1", "acme")
        self.assertEqual(other.models, ("o",))
        self.assertEqual(len(entitlement_calls(client)), 2)

    async def test_cache_expires(self) -> None:
        now = [1000.0]
        resolver, client = self.resolver(
            [FakeResponse(200, body(ttl=600)), FakeResponse(200, body(ttl=600))],
            clock=lambda: now[0],
        )
        await resolver.resolve("token-a", "user-1", "acme")
        now[0] += entitlements.TTL_S + 1
        await resolver.resolve("token-a", "user-1", "acme")
        self.assertEqual(len(entitlement_calls(client)), 2)

    async def test_cache_never_outlives_the_decision(self) -> None:
        now = [1000.0]
        resolver, client = self.resolver(
            [FakeResponse(200, body(ttl=5)), FakeResponse(200, body(ttl=60))],
            clock=lambda: now[0],
        )
        await resolver.resolve("token-a", "user-1", "acme")
        now[0] += 6
        await resolver.resolve("token-a", "user-1", "acme")
        self.assertEqual(len(entitlement_calls(client)), 2)

    async def test_an_already_expired_decision_is_refused(self) -> None:
        resolver, _ = self.resolver([FakeResponse(200, body(ttl=-1))])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("token-a", "user-1", "acme")

    async def test_an_answer_for_another_person_or_application_is_refused(self) -> None:
        for answer in (body(subject="user-2"), body(client="other")):
            resolver, _ = self.resolver([FakeResponse(200, answer)])
            with self.assertRaises(entitlements.EntitlementsUnavailable):
                await resolver.resolve("token-a", "user-1", "acme")

    async def test_a_refused_client_is_denied_not_unavailable(self) -> None:
        resolver, _ = self.resolver([FakeResponse(403, {})])
        with self.assertRaises(entitlements.EntitlementsDenied):
            await resolver.resolve("token-a", "user-1", "acme")

    async def test_http_error_is_unavailable(self) -> None:
        resolver, _ = self.resolver([FakeResponse(503, {})])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("token-a", "user-1", "acme")

    async def test_malformed_payload_is_unavailable(self) -> None:
        resolver, _ = self.resolver([FakeResponse(200, {"models": [1]})])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("token-a", "user-1", "acme")

    async def test_a_payload_without_a_decision_is_unavailable(self) -> None:
        answer = body()
        del answer["decisionId"]
        resolver, _ = self.resolver([FakeResponse(200, answer)])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("token-a", "user-1", "acme")

    async def test_resolve_key_never_caches(self) -> None:
        resolver, client = self.resolver(
            [
                FakeResponse(200, body(key_id="key-1")),
                FakeResponse(200, body(key_id="key-1", models=("o",))),
            ]
        )
        first = await resolver.resolve_key("cgk_" + "A" * 43)
        self.assertEqual(first.key_id, "key-1")
        second = await resolver.resolve_key("cgk_" + "A" * 43)
        self.assertEqual(second.models, ("o",))
        calls = [c for c in client.calls if c[1].endswith("/personal-keys/entitlements")]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][2]["json"], {"key": "cgk_" + "A" * 43})

    async def test_resolve_key_refreshes_the_machine_token_on_401(self) -> None:
        resolver, client = self.resolver(
            [
                FakeResponse(401, {"error": {"code": "AUTH_001"}}),
                FakeResponse(200, body(key_id="key-1")),
            ]
        )
        result = await resolver.resolve_key("cgk_" + "A" * 43)
        self.assertEqual(result.key_id, "key-1")
        tokens = [c for c in client.calls if c[1].endswith("/oauth2/token")]
        self.assertEqual(len(tokens), 2)

    async def test_resolve_key_maps_refusals(self) -> None:
        resolver, client = self.resolver(
            [FakeResponse(401, {"error": {"code": "KEY_001"}})]
        )
        with self.assertRaises(entitlements.EntitlementsRejected):
            await resolver.resolve_key("cgk_" + "A" * 43)
        tokens = [c for c in client.calls if c[1].endswith("/oauth2/token")]
        self.assertEqual(len(tokens), 1)

        resolver, _ = self.resolver([FakeResponse(403, {})])
        with self.assertRaises(entitlements.EntitlementsDenied):
            await resolver.resolve_key("cgk_" + "A" * 43)

        resolver, _ = self.resolver([FakeResponse(503, {})])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve_key("cgk_" + "A" * 43)

    async def test_resolve_key_requires_a_key_id_in_the_answer(self) -> None:
        resolver, _ = self.resolver([FakeResponse(200, body())])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve_key("cgk_" + "A" * 43)

    async def test_resolve_key_refuses_an_expired_decision(self) -> None:
        resolver, _ = self.resolver([FakeResponse(200, body(key_id="key-1", ttl=-1))])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve_key("cgk_" + "A" * 43)

    async def test_401_refreshes_the_token_once(self) -> None:
        resolver, client = self.resolver(
            [FakeResponse(401, {}), FakeResponse(200, body())]
        )
        result = await resolver.resolve("token-a", "user-1", "acme")
        self.assertEqual(result.models, ("gpt-x",))
        tokens = [c for c in client.calls if c[1].endswith("/oauth2/token")]
        self.assertEqual(len(tokens), 2)


if __name__ == "__main__":
    unittest.main()
