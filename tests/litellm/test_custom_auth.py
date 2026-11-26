"""Route policy of the gateway's custom auth hook, run against the real LiteLLM.

    pnpm test:litellm

The hook imports LiteLLM's own route tables, so the test runs inside the pinned
LiteLLM image rather than against stubs.
"""

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

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
}.items():
    os.environ.setdefault(name, value)

sys.path.insert(0, str(Path(os.environ.get("GATEWAY_DIR", "/gateway"))))

import custom_auth  # noqa: E402
import entitlements  # noqa: E402
from entitlements import (  # noqa: E402
    EntitlementResource,
    Entitlements,
    EntitlementsDenied,
    EntitlementsRejected,
    EntitlementsUnavailable,
)


class ClientRoutePolicy(unittest.TestCase):
    def allowed(self, method: str, path: str) -> bool:
        return custom_auth._is_client_route(path, method)

    def test_llm_and_mcp_routes_stay_open(self) -> None:
        for method, path in [
            ("POST", "/v1/chat/completions"),
            ("GET", "/v1/models"),
            ("POST", "/v1/embeddings"),
            ("POST", "/mcp"),
            ("GET", "/mcp/"),
            ("POST", "/docs-server/mcp"),
            ("POST", "/docs-server/mcp/sse"),
            ("POST", "/a2a/owner-agent/message/send"),
            ("POST", "/v1/a2a/owner-agent/message/send"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertTrue(self.allowed(method, path))

    def test_mcp_management_writes_stay_closed(self) -> None:
        for method, path in [
            ("POST", "/v1/mcp/server"),
            ("PUT", "/v1/mcp/server"),
            ("DELETE", "/v1/mcp/server/abc"),
            ("POST", "/v1/mcp/server/abc/approve"),
            ("GET", "/v1/mcp/sessions"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertFalse(self.allowed(method, path))

    def test_discovery_is_open_for_get_only(self) -> None:
        for path in ["/v1/agents", "/v1/mcp/server"]:
            with self.subTest(path=path):
                self.assertTrue(self.allowed("GET", path))
                for method in ["POST", "PUT", "PATCH", "DELETE"]:
                    self.assertFalse(self.allowed(method, path), method)

    def test_discovery_does_not_open_neighbouring_routes(self) -> None:
        for path in [
            "/v1/agents/",
            "/v1/agents/abc",
            "/v1/agents/make_public",
            "/v1/agents/abc/kill_switch",
            "/v1/mcp/server/",
            "/v1/mcp/server/abc",
            "/v1/mcp/server/abc/approve",
            "/v1/mcp/sessions",
            "/v1/agents//",
            "//v1/agents",
            "/V1/agents",
            "/V1/mcp/server/abc",
            "/v1/mcp/discover",
        ]:
            with self.subTest(path=path):
                self.assertFalse(self.allowed("GET", path))

    def test_administration_routes_stay_closed(self) -> None:
        for method, path in [
            ("POST", "/key/generate"),
            ("POST", "/user/new"),
            ("POST", "/team/new"),
            ("GET", "/spend/logs"),
            ("GET", "/user/list"),
            ("POST", "/model/new"),
            ("POST", "/model/update"),
            ("POST", "/model/delete"),
            ("POST", "/key/update"),
            ("POST", "/key/delete"),
            ("POST", "/user/update"),
            ("POST", "/user/delete"),
            ("POST", "/team/update"),
            ("POST", "/team/delete"),
            ("POST", "/organization/new"),
            ("POST", "/config/update"),
            ("POST", "/cache/flush"),
            ("POST", "/v1/a2a/discover"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertFalse(self.allowed(method, path))


class EntitlementIdentity(unittest.TestCase):
    def test_accepts_eddsa_and_es256_tokens(self) -> None:
        self.assertIn("EdDSA", custom_auth.ALGORITHMS)
        self.assertIn("ES256", custom_auth.ALGORITHMS)
        self.assertEqual(custom_auth.AUDIENCES, ["https://llm.test"])

    def test_entitlements_become_a_key_object_permission(self) -> None:
        entitlements = Entitlements(
            models=("gpt-x", "claude-x"),
            agents=("analyst",),
            mcp_servers=("server-x",),
            mcp_tool_permissions={"server-x": ("search",)},
            resources=(
                EntitlementResource(
                    resource_id="r1",
                    uri="llm://acme/gpt-x",
                    scheme="llm",
                    kind="model",
                    name="gpt-x",
                    parent_name="",
                    application_slug="acme",
                    owner_type="application",
                ),
            ),
            decision_id="decision-1",
            subject_id="user-1",
            client_id="acme",
        )
        identity = custom_auth._identity(
            {"sub": "user-1", "azp": "acme", "preferred_username": "alice"},
            entitlements,
        )
        self.assertEqual(identity.models, ["gpt-x", "claude-x"])
        self.assertEqual(identity.metadata["preferredUsername"], "alice")
        self.assertIsNone(identity.team_id)
        permission = identity.object_permission
        self.assertIsNotNone(permission)
        self.assertEqual(permission.models, ["gpt-x", "claude-x"])
        self.assertEqual(permission.agents, ["analyst"])
        self.assertEqual(permission.mcp_servers, ["server-x"])
        self.assertEqual(permission.mcp_tool_permissions, {"server-x": ["search"]})
        usage = identity.metadata["resourceUsage"]
        self.assertEqual(usage["decisionId"], "decision-1")
        self.assertNotIn("subjectId", usage)
        self.assertNotIn("clientId", usage)
        self.assertNotIn("ownerId", usage["resources"][0])
        self.assertEqual(usage["resources"][0]["resourceId"], "r1")
        self.assertEqual(usage["resources"][0]["name"], "gpt-x")

    def test_empty_entitlements_use_explicit_deny_sentinels(self) -> None:
        identity = custom_auth._identity(
            {"sub": "user-1", "azp": "acme"},
            Entitlements((), (), (), {}, ()),
        )
        self.assertEqual(identity.models, [custom_auth.NO_MODEL_SENTINEL])
        permission = identity.object_permission
        self.assertEqual(permission.mcp_servers, [custom_auth.NO_MCP_SENTINEL])
        self.assertEqual(permission.agents, [])
        self.assertEqual(permission.mcp_tool_permissions, None)


VALID_KEY = "cgk_" + "A" * 43


class FakeKeyResolver:
    def __init__(self, answer=None, error=None):
        self.answer = answer
        self.error = error
        self.calls = 0

    async def resolve_key(self, key):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.answer


def request(path):
    return SimpleNamespace(url=SimpleNamespace(path=path), method="POST")


def key_entitlements(**overrides):
    values = {
        "models": ("gpt-x",),
        "agents": ("analyst",),
        "mcp_servers": ("server-x",),
        "mcp_tool_permissions": {"server-x": ("search",)},
        "resources": (),
        "decision_id": "decision-1",
        "subject_id": "user-1",
        "client_id": "acme",
        "key_id": "key-1",
    }
    values.update(overrides)
    return Entitlements(**values)


class PersonalGatewayKey(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        entitlements.set_resolver_for_tests(None)

    async def test_identity_is_built_from_the_answer(self) -> None:
        fake = FakeKeyResolver(key_entitlements())
        entitlements.set_resolver_for_tests(fake)
        identity = await custom_auth.user_api_key_auth(
            request("/v1/chat/completions"), VALID_KEY
        )
        self.assertEqual(identity.api_key, "cgk:key-1")
        self.assertEqual(identity.user_id, "user-1")
        self.assertEqual(identity.metadata["azp"], "acme")
        self.assertEqual(identity.metadata["preferredUsername"], "")
        self.assertEqual(identity.models, ["gpt-x"])
        self.assertEqual(identity.object_permission.agents, ["analyst"])
        self.assertEqual(fake.calls, 1)
        self.assertNotIn(VALID_KEY, identity.api_key)
        self.assertNotIn(VALID_KEY, repr(identity.metadata))

    async def test_empty_lists_become_sentinels(self) -> None:
        entitlements.set_resolver_for_tests(
            FakeKeyResolver(
                key_entitlements(
                    models=(),
                    agents=(),
                    mcp_servers=(),
                    mcp_tool_permissions={},
                )
            )
        )
        identity = await custom_auth.user_api_key_auth(
            request("/v1/models"), VALID_KEY
        )
        self.assertEqual(identity.models, [custom_auth.NO_MODEL_SENTINEL])
        self.assertEqual(
            identity.object_permission.mcp_servers,
            [custom_auth.NO_MCP_SENTINEL],
        )

    async def test_key_is_resolved_on_every_request(self) -> None:
        fake = FakeKeyResolver(key_entitlements())
        entitlements.set_resolver_for_tests(fake)
        await custom_auth.user_api_key_auth(request("/v1/models"), VALID_KEY)
        await custom_auth.user_api_key_auth(request("/v1/models"), VALID_KEY)
        self.assertEqual(fake.calls, 2)

    async def test_client_route_guard_and_format_are_enforced(self) -> None:
        fake = FakeKeyResolver(key_entitlements())
        entitlements.set_resolver_for_tests(fake)

        with self.assertRaises(custom_auth.ProxyException) as guard:
            await custom_auth.user_api_key_auth(request("/key/generate"), VALID_KEY)
        self.assertEqual(guard.exception.code, "403")

        with self.assertRaises(custom_auth.ProxyException) as malformed:
            await custom_auth.user_api_key_auth(request("/v1/models"), "cgk_short")
        self.assertEqual(malformed.exception.code, "401")
        self.assertEqual(fake.calls, 0)

    async def test_resolution_errors_map_like_the_jwt_path(self) -> None:
        cases = [
            (EntitlementsRejected("no"), 401),
            (EntitlementsDenied("no"), 403),
            (EntitlementsUnavailable("no"), 503),
        ]
        for error, status in cases:
            entitlements.set_resolver_for_tests(FakeKeyResolver(error=error))
            with self.assertRaises(custom_auth.ProxyException) as raised:
                await custom_auth.user_api_key_auth(
                    request("/v1/models"), VALID_KEY
                )
            self.assertEqual(raised.exception.code, str(status))


if __name__ == "__main__":
    unittest.main()
