"""Route policy of the gateway's custom auth hook, run against the real LiteLLM.

    pnpm test:litellm

The hook imports LiteLLM's own route tables, so the test runs inside the pinned
LiteLLM image rather than against stubs.
"""

import os
import sys
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
}.items():
    os.environ.setdefault(name, value)

sys.path.insert(0, str(Path(os.environ.get("GATEWAY_DIR", "/gateway"))))

import custom_auth  # noqa: E402


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
        ]:
            with self.subTest(method=method, path=path):
                self.assertFalse(self.allowed(method, path))


if __name__ == "__main__":
    unittest.main()
