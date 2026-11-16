"""Entitlement resolver: parsing, cache and fail-closed behaviour."""

import os
import sys
import unittest
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
        return FakeResponse(200, {"access_token": "token", "expires_in": 300})

    async def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.responses.pop(0)


def body(models=("gpt-x",), agents=("analyst",)):
    return {
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
                "ownerId": "acme",
            }
        ],
    }


class Resolver(unittest.IsolatedAsyncioTestCase):
    def resolver(self, responses, clock=None):
        client = FakeClient(responses)
        return (
            entitlements.EntitlementResolver(
                client=client,
                clock=clock or (lambda: 1000.0),
            ),
            client,
        )

    async def test_resolves_and_caches_per_subject_and_client(self) -> None:
        now = [1000.0]
        resolver, client = self.resolver(
            [FakeResponse(200, body()), FakeResponse(200, body(models=("o",)))],
            clock=lambda: now[0],
        )
        first = await resolver.resolve("user-1", "acme")
        self.assertEqual(first.models, ("gpt-x",))
        self.assertEqual(first.mcp_tool_permissions, {"server-x": ("search",)})
        self.assertEqual(first.resources[0].parent_name, "")

        now[0] += 10
        again = await resolver.resolve("user-1", "acme")
        self.assertEqual(again.models, ("gpt-x",))
        self.assertEqual(len([c for c in client.calls if c[0] == "GET"]), 1)

        other = await resolver.resolve("user-1", "other")
        self.assertEqual(other.models, ("o",))
        self.assertEqual(len([c for c in client.calls if c[0] == "GET"]), 2)

    async def test_cache_expires(self) -> None:
        now = [1000.0]
        resolver, client = self.resolver(
            [FakeResponse(200, body()), FakeResponse(200, body())],
            clock=lambda: now[0],
        )
        await resolver.resolve("user-1", "acme")
        now[0] += entitlements.TTL_S + 1
        await resolver.resolve("user-1", "acme")
        self.assertEqual(len([c for c in client.calls if c[0] == "GET"]), 2)

    async def test_http_error_is_unavailable(self) -> None:
        resolver, _ = self.resolver([FakeResponse(503, {})])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("user-1", "acme")

    async def test_malformed_payload_is_unavailable(self) -> None:
        resolver, _ = self.resolver([FakeResponse(200, {"models": [1]})])
        with self.assertRaises(entitlements.EntitlementsUnavailable):
            await resolver.resolve("user-1", "acme")

    async def test_401_refreshes_the_token_once(self) -> None:
        resolver, client = self.resolver(
            [FakeResponse(401, {}), FakeResponse(200, body())]
        )
        result = await resolver.resolve("user-1", "acme")
        self.assertEqual(result.models, ("gpt-x",))
        tokens = [c for c in client.calls if c[0] == "POST"]
        self.assertEqual(len(tokens), 2)


if __name__ == "__main__":
    unittest.main()
