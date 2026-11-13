"""Resource-sharing policy client and route mapping, against fakes.

The test runs inside the pinned LiteLLM image (like the rest of this suite), but
never starts a proxy, reaches auth-service, or uses a real secret. The fake
auth-service is an ``httpx.MockTransport``; routing uses a tiny router stub.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

for name, value in {
    "JWT_PUBLIC_KEY_URL": "https://auth.test/api/auth/jwks",
    "JWT_ISSUER": "https://auth.test",
    "JWT_AUDIENCE": "https://llm.test",
    "LITELLM_MASTER_KEY": "sk-master",
    "LITELLM_SALT_KEY": "salt",
    "WALLET_AUTH_URL": "https://auth.test",
    "WALLET_CLIENT_ID": "litellm-wallet",
    "WALLET_CLIENT_SECRET": "secret",
    "RESOURCE_CLIENT_ID": "litellm-resources",
    "RESOURCE_CLIENT_SECRET": "resource-secret",
}.items():
    os.environ.setdefault(name, value)

sys.path.insert(0, str(Path(os.environ.get("GATEWAY_DIR", "/gateway"))))

import httpx  # noqa: E402

import resource_discovery  # noqa: E402
import resource_routing  # noqa: E402
import resource_sharing  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeRouter:
    model_group_alias = {"public-alias": "owner/model"}

    def __init__(self) -> None:
        self.fallbacks = []
        self.context_window_fallbacks = []
        self.content_policy_fallbacks = []

    def get_model_names(self):
        return ["owner/model", "owner/fallback"]

    def get_deployment(self, model_id):
        return object() if model_id == "deployment-id" else None

    def get_model_list(self, model_name=None):
        if model_name in self.get_model_names():
            return [{"model_name": model_name}]
        return []


class FakePolicy:
    def __init__(self, allow=None) -> None:
        self.allow = allow or {}
        self.calls = []

    async def authorize(self, **kwargs):
        self.calls.append(kwargs)
        entry = self.allow.get(kwargs["key"])
        if isinstance(entry, Exception):
            raise entry
        return entry

    async def accessible(self, **kwargs):
        return tuple(self.allow.get("__accessible__", ()))


def allow(key, team="owner:Team"):
    return resource_sharing.ResourceDecision(
        resource_id=f"id-{key}",
        key=key,
        resource_type="model",
        owner_application_slug="owner",
        plan_name="Team",
        team_id=team,
    )


class FakeRequest:
    def __init__(self, path, method, body=None, headers=None, query=None):
        self.method = method
        self.url = type("URL", (), {"path": path})()
        self.headers = headers or {}
        self.query_params = query or {}
        self.body = body or {}
        self.scope = {"parsed_body": (tuple(self.body.keys()), self.body)}


class ModelResolution(unittest.TestCase):
    def test_alias_resolves_to_its_model_group(self) -> None:
        self.assertEqual(
            resource_routing.resolve_model_key(FakeRouter(), "public-alias"),
            "owner/model",
        )

    def test_direct_deployment_id_is_refused(self) -> None:
        with self.assertRaises(resource_sharing.ResourceNotFound):
            resource_routing.resolve_model_key(FakeRouter(), "deployment-id")

    def test_unknown_model_is_refused(self) -> None:
        with self.assertRaises(resource_sharing.ResourceNotFound):
            resource_routing.resolve_model_key(FakeRouter(), "ghost/model")

    def test_client_supplied_fallback_is_refused(self) -> None:
        router = FakeRouter()
        with self.assertRaises(resource_sharing.ResourceNotFound):
            resource_routing.model_resource_keys(
                router,
                ["owner/model"],
                {"model": "owner/model", "fallbacks": ["owner/other"]},
            )

    def test_router_override_is_refused(self) -> None:
        router = FakeRouter()
        with self.assertRaises(resource_sharing.ResourceNotFound):
            resource_routing.model_resource_keys(
                router,
                ["owner/model"],
                {"model": "owner/model", "router_settings_override": {}},
            )

    def test_configured_fallbacks_are_authorized_too(self) -> None:
        router = FakeRouter()
        router.fallbacks = [{"owner/model": ["owner/fallback"]}]
        self.assertEqual(
            resource_routing.model_resource_keys(router, ["owner/model"], {}),
            ["owner/model", "owner/fallback"],
        )

    def test_fallback_to_unknown_model_is_refused(self) -> None:
        router = FakeRouter()
        router.fallbacks = [{"owner/model": ["ghost/model"]}]
        with self.assertRaises(resource_sharing.ResourceNotFound):
            resource_routing.model_resource_keys(router, ["owner/model"], {})


class Enforce(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.previous = resource_routing.RESOURCE_SHARING_ENABLED
        resource_routing.RESOURCE_SHARING_ENABLED = True

    def tearDown(self) -> None:
        resource_routing.RESOURCE_SHARING_ENABLED = self.previous

    async def enforce(self, request, policy, router=None):
        return await resource_routing.enforce_resource_access(
            request,
            subject_id="subject-a",
            client_id="client-a",
            audience="https://llm.test",
            body=request.body,
            router=router or FakeRouter(),
            policy=policy,
        )

    async def test_allow_returns_the_owner_plan_team(self) -> None:
        policy = FakePolicy({"owner/model": allow("owner/model")})
        context = await self.enforce(
            FakeRequest("/v1/chat/completions", "POST", {"model": "public-alias"}),
            policy,
        )
        self.assertEqual(context.team_id, "owner:Team")
        self.assertEqual(
            policy.calls[0]["key"],
            "owner/model",
        )
        self.assertEqual(policy.calls[0]["client_id"], "client-a")
        self.assertEqual(policy.calls[0]["audience"], "https://llm.test")

    async def test_one_subject_reaches_two_independently_granted_resources(self) -> None:
        router = FakeRouter()
        policy = FakePolicy(
            {
                "owner/model": allow("owner/model"),
                "owner/fallback": allow("owner/fallback"),
            }
        )
        for key in ("owner/model", "owner/fallback"):
            context = await self.enforce(
                FakeRequest("/v1/chat/completions", "POST", {"model": key}),
                policy,
                router,
            )
            self.assertEqual(context.team_id, "owner:Team")
            self.assertEqual(context.subject_id, "subject-a")

    async def test_denial_is_uniform_not_found(self) -> None:
        with self.assertRaises(resource_sharing.ResourceNotFound):
            await self.enforce(
                FakeRequest("/v1/chat/completions", "POST", {"model": "owner/model"}),
                FakePolicy(),
            )

    async def test_upstream_failure_is_unavailable(self) -> None:
        policy = FakePolicy({"owner/model": resource_sharing.ResourceUnavailable()})
        with self.assertRaises(resource_sharing.ResourceUnavailable):
            await self.enforce(
                FakeRequest("/v1/chat/completions", "POST", {"model": "owner/model"}),
                policy,
            )

    async def test_all_resources_must_share_one_team(self) -> None:
        router = FakeRouter()
        router.fallbacks = [{"owner/model": ["owner/fallback"]}]
        policy = FakePolicy(
            {
                "owner/model": allow("owner/model", "owner:Team"),
                "owner/fallback": allow("owner/fallback", "other:Team"),
            }
        )
        with self.assertRaises(resource_sharing.ResourceNotFound):
            await self.enforce(
                FakeRequest("/v1/chat/completions", "POST", {"model": "owner/model"}),
                policy,
                router,
            )

    async def test_unsupported_route_is_uniform_not_found(self) -> None:
        with self.assertRaises(resource_sharing.ResourceNotFound):
            await self.enforce(FakeRequest("/v1/mcp/sessions", "GET", {}), FakePolicy())

    async def test_discovery_skips_per_resource_policy(self) -> None:
        request = FakeRequest("/v1/models", "GET")
        self.assertIsNone(await self.enforce(request, FakePolicy()))

    async def test_mcp_discovery_scope_bypass_is_refused(self) -> None:
        request = FakeRequest("/v1/mcp/server", "GET", query={"team_id": "x"})
        with mock.patch.object(resource_discovery, "ensure_discovery_filters", return_value=True):
            with self.assertRaises(resource_sharing.ResourceNotFound):
                await self.enforce(request, FakePolicy())

    async def test_flag_off_never_calls_policy(self) -> None:
        resource_routing.RESOURCE_SHARING_ENABLED = False
        policy = FakePolicy()
        self.assertIsNone(
            await self.enforce(
                FakeRequest("/v1/chat/completions", "POST", {"model": "owner/model"}),
                policy,
            )
        )
        self.assertEqual(policy.calls, [])


class TeamFallbacks(unittest.IsolatedAsyncioTestCase):
    def context(self, *keys):
        return resource_routing.SharingContext(
            team_id="owner:Team",
            subject_id="subject-a",
            client_id="client-a",
            audience="https://llm.test",
            resources=tuple(allow(key) for key in keys),
        )

    async def test_team_fallback_is_authorized_for_the_same_team(self) -> None:
        policy = FakePolicy(
            {
                "owner/model": allow("owner/model"),
                "owner/fallback": allow("owner/fallback"),
            }
        )
        result = await resource_routing.authorize_team_fallbacks(
            self.context("owner/model"),
            object(),
            router=FakeRouter(),
            policy=policy,
            settings={"fallbacks": [{"owner/model": ["owner/fallback"]}]},
        )
        self.assertEqual([item.key for item in result.resources], ["owner/model", "owner/fallback"])

    async def test_team_fallback_on_another_team_is_refused(self) -> None:
        policy = FakePolicy(
            {
                "owner/model": allow("owner/model"),
                "owner/fallback": allow("owner/fallback", "other:Team"),
            }
        )
        with self.assertRaises(resource_sharing.ResourceNotFound):
            await resource_routing.authorize_team_fallbacks(
                self.context("owner/model"),
                object(),
                router=FakeRouter(),
                policy=policy,
                settings={"fallbacks": [{"owner/model": ["owner/fallback"]}]},
            )

    async def test_team_model_alias_is_refused_as_ambiguous(self) -> None:
        with self.assertRaises(resource_sharing.ResourceNotFound):
            await resource_routing.authorize_team_fallbacks(
                self.context("owner/model"),
                object(),
                router=FakeRouter(),
                policy=FakePolicy(),
                settings={"model_group_alias": {"public": "owner/other"}},
            )

    async def test_no_settings_is_a_noop(self) -> None:
        context = self.context("owner/model")
        self.assertEqual(
            await resource_routing.authorize_team_fallbacks(
                context, object(), router=FakeRouter(), policy=FakePolicy(), settings={}
            ),
            context,
        )


class CustomAuthBranch(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import custom_auth

        cls.custom_auth = custom_auth

    def claims(self):
        return {"sub": "subject-a", "azp": "client-a"}

    async def test_policy_denial_becomes_uniform_404(self) -> None:
        with mock.patch.object(
            self.custom_auth,
            "enforce_resource_access",
            side_effect=resource_sharing.ResourceNotFound(),
        ):
            with self.assertRaises(Exception) as caught:
                await self.custom_auth._resource_aware_identity(
                    FakeRequest("/v1/chat/completions", "POST"), self.claims()
                )
        self.assertEqual(str(caught.exception.code), "404")
        self.assertNotIn("owner", str(caught.exception.message))

    async def test_policy_outage_becomes_503_without_owner_metadata(self) -> None:
        with mock.patch.object(
            self.custom_auth,
            "enforce_resource_access",
            side_effect=resource_sharing.ResourceUnavailable(),
        ):
            with self.assertRaises(Exception) as caught:
                await self.custom_auth._resource_aware_identity(
                    FakeRequest("/v1/chat/completions", "POST"), self.claims()
                )
        self.assertEqual(str(caught.exception.code), "503")
        self.assertNotIn("owner", str(caught.exception.message))

    async def test_discovery_identity_carries_no_team_and_the_filter_marker(self) -> None:
        with mock.patch.object(
            self.custom_auth, "enforce_resource_access", return_value=None
        ):
            identity = await self.custom_auth._resource_aware_identity(
                FakeRequest("/v1/models", "GET"), self.claims()
            )
        self.assertIsNone(identity.team_id)
        self.assertEqual(identity.metadata["azp"], "client-a")
        self.assertTrue(identity.metadata[resource_sharing.SHARING_METADATA_KEY])

    async def test_allow_attaches_exactly_the_owner_plan_team(self) -> None:
        from types import SimpleNamespace

        context = resource_routing.SharingContext(
            team_id="owner:Team",
            subject_id="subject-a",
            client_id="client-a",
            audience="https://llm.test",
            resources=(allow("owner/model"),),
        )
        team = SimpleNamespace(
            team_id="owner:Team",
            blocked=False,
            models=["owner/model"],
            rpm_limit=10,
            tpm_limit=20,
            max_budget=5.0,
            spend=0.0,
            metadata={},
            object_permission_id=None,
            object_permission=None,
        )
        with mock.patch.object(
            self.custom_auth, "enforce_resource_access", return_value=context
        ):
            with mock.patch.object(
                self.custom_auth, "_sharing_team", return_value=team
            ):
                with mock.patch.object(
                    self.custom_auth,
                    "authorize_team_fallbacks",
                    return_value=context,
                ):
                    identity = await self.custom_auth._resource_aware_identity(
                        FakeRequest("/v1/chat/completions", "POST"), self.claims()
                    )
        self.assertEqual(identity.team_id, "owner:Team")
        self.assertEqual(identity.user_id, "subject-a")
        self.assertEqual(identity.metadata["azp"], "client-a")
        self.assertTrue(identity.metadata[resource_sharing.SHARING_METADATA_KEY])

    def test_flag_off_identity_has_no_sharing_marker(self) -> None:
        from types import SimpleNamespace

        team = SimpleNamespace(
            team_id="app:Plan",
            blocked=False,
            models=[],
            rpm_limit=None,
            tpm_limit=None,
            max_budget=None,
            spend=0.0,
            metadata={},
            object_permission_id=None,
            object_permission=None,
        )
        identity = self.custom_auth._identity(self.claims(), team)
        self.assertEqual(identity.metadata, {"azp": "client-a"})


class AuthorizerTransport(unittest.IsolatedAsyncioTestCase):
    def authorizer(self, handler, clock, **kwargs):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return resource_sharing.ResourceAuthorizer(
            auth_url="https://auth.test",
            client_id="litellm-resources",
            client_secret="resource-secret",
            client=client,
            clock=clock,
            ttl_s=kwargs.pop("ttl_s", 30.0),
            max_entries=kwargs.pop("max_entries", 16),
        )

    @staticmethod
    def allow_response(team="owner:Team"):
        return {
            "decision": "allow",
            "ownerApplicationSlug": "owner",
            "planName": "Team",
            "teamId": team,
            "resourceId": "resource-1",
        }

    async def test_allow_is_cached_and_request_id_is_not_part_of_the_key(self) -> None:
        clock = Clock()
        posts = []

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            posts.append(request)
            return httpx.Response(200, json=self.allow_response())

        authorizer = self.authorizer(handler, clock)
        first = await authorizer.authorize(
            subject_id="subject-a",
            client_id="client-a",
            resource_type="model",
            key="owner/model",
            audience="https://llm.test",
            request_id="one",
        )
        second = await authorizer.authorize(
            subject_id="subject-a",
            client_id="client-a",
            resource_type="model",
            key="owner/model",
            audience="https://llm.test",
            request_id="two",
        )
        self.assertEqual(first, second)
        self.assertEqual(len(posts), 1)
        body = posts[0].read().decode()
        self.assertIn('"subjectId":"subject-a"', body)
        self.assertIn('"requestId":"one"', body)

    async def test_deny_is_cached_within_the_ttl_and_revoked_after_it(self) -> None:
        clock = Clock()
        replies = [{"decision": "deny"}, self.allow_response()]

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            return httpx.Response(200, json=replies.pop(0))

        authorizer = self.authorizer(handler, clock)
        args = dict(
            subject_id="subject-a",
            client_id="client-a",
            resource_type="model",
            key="owner/model",
            audience="https://llm.test",
            request_id="one",
        )
        self.assertIsNone(await authorizer.authorize(**args))
        self.assertIsNone(await authorizer.authorize(**args))
        clock.advance(31)
        decision = await authorizer.authorize(**args)
        self.assertIsNotNone(decision)
        self.assertEqual(decision.team_id, "owner:Team")

    async def test_cache_is_scoped_by_subject_client_resource_and_audience(self) -> None:
        clock = Clock()
        posts = []

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            posts.append(request)
            return httpx.Response(200, json=self.allow_response())

        authorizer = self.authorizer(handler, clock)
        base = dict(
            resource_type="model",
            key="owner/model",
            audience="https://llm.test",
            request_id="one",
        )
        await authorizer.authorize(subject_id="subject-a", client_id="client-a", **base)
        await authorizer.authorize(subject_id="subject-b", client_id="client-a", **base)
        await authorizer.authorize(subject_id="subject-a", client_id="client-b", **base)
        await authorizer.authorize(subject_id="subject-a", client_id="client-a", **{**base, "key": "owner/other"})
        await authorizer.authorize(subject_id="subject-a", client_id="client-a", **{**base, "audience": "https://other.test"})
        self.assertEqual(len(posts), 5)

    async def test_bounded_cache_evicts_oldest(self) -> None:
        clock = Clock()
        posts = []

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            posts.append(request)
            return httpx.Response(200, json=self.allow_response())

        authorizer = self.authorizer(handler, clock, max_entries=1)
        for key in ("owner/a", "owner/b", "owner/a"):
            await authorizer.authorize(
                subject_id="subject-a",
                client_id="client-a",
                resource_type="model",
                key=key,
                audience="https://llm.test",
                request_id="one",
            )
        self.assertEqual(len(posts), 3)

    async def test_network_error_is_unavailable_and_not_cached(self) -> None:
        clock = Clock()
        posts = []

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            posts.append(request)
            raise httpx.ConnectError("down", request=request)

        authorizer = self.authorizer(handler, clock)
        args = dict(
            subject_id="subject-a",
            client_id="client-a",
            resource_type="model",
            key="owner/model",
            audience="https://llm.test",
            request_id="one",
        )
        for _ in range(2):
            with self.assertRaises(resource_sharing.ResourceUnavailable):
                await authorizer.authorize(**args)
        self.assertEqual(len(posts), 2)

    async def test_http_error_is_unavailable(self) -> None:
        clock = Clock()

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            return httpx.Response(500)

        authorizer = self.authorizer(handler, clock)
        with self.assertRaises(resource_sharing.ResourceUnavailable):
            await authorizer.authorize(
                subject_id="subject-a",
                client_id="client-a",
                resource_type="model",
                key="owner/model",
                audience="https://llm.test",
                request_id="one",
            )

    async def test_accessible_is_cached_per_subject_scope(self) -> None:
        clock = Clock()
        gets = []

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            gets.append(request)
            return httpx.Response(
                200,
                json={
                    "resources": [
                        {"resourceKey": "owner/a"},
                        {"resourceKey": "owner/b"},
                    ]
                },
            )

        authorizer = self.authorizer(handler, clock)
        args = dict(
            subject_id="subject-a",
            client_id="client-a",
            resource_type="model",
            audience="https://llm.test",
        )
        self.assertEqual(await authorizer.accessible(**args), ("owner/a", "owner/b"))
        self.assertEqual(await authorizer.accessible(**args), ("owner/a", "owner/b"))
        self.assertEqual(len(gets), 1)

    async def test_malformed_allow_is_unavailable(self) -> None:
        clock = Clock()

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
            return httpx.Response(200, json={"decision": "allow", "teamId": "owner:Team"})

        authorizer = self.authorizer(handler, clock)
        with self.assertRaises(resource_sharing.ResourceUnavailable):
            await authorizer.authorize(
                subject_id="subject-a",
                client_id="client-a",
                resource_type="model",
                key="owner/model",
                audience="https://llm.test",
                request_id="one",
            )


class DiscoveryFilters(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.previous = resource_routing.RESOURCE_SHARING_ENABLED
        self.previous_discovery = resource_discovery.RESOURCE_SHARING_ENABLED
        resource_routing.RESOURCE_SHARING_ENABLED = True
        resource_discovery.RESOURCE_SHARING_ENABLED = True

    def tearDown(self) -> None:
        resource_routing.RESOURCE_SHARING_ENABLED = self.previous
        resource_discovery.RESOURCE_SHARING_ENABLED = self.previous_discovery

    def user(self, role="customer", metadata=None):
        auth = type(
            "Auth",
            (),
            {
                "authenticated_by_custom_auth": True,
                "user_id": "subject-a",
                "user_role": role,
                "metadata": metadata
                if metadata is not None
                else {"azp": "client-a", resource_sharing.SHARING_METADATA_KEY: True},
            },
        )()
        return auth

    async def test_model_list_is_narrowed_to_accessible_models(self) -> None:
        policy = FakePolicy({"__accessible__": ("owner/model",)})
        with mock.patch.object(resource_discovery, "authorizer", return_value=policy):
            with mock.patch.object(resource_discovery, "_router", return_value=FakeRouter()):
                kept = await resource_discovery.resource_sharing_logger.async_filter_listed_models(
                    self.user(),
                    ["owner/model", "owner/fallback", "public-alias"],
                )
        self.assertEqual(kept, ["owner/model", "public-alias"])

    async def test_empty_access_list_reveals_no_catalogue(self) -> None:
        policy = FakePolicy({"__accessible__": ()})
        with mock.patch.object(resource_discovery, "authorizer", return_value=policy):
            with mock.patch.object(resource_discovery, "_router", return_value=FakeRouter()):
                kept = await resource_discovery.resource_sharing_logger.async_filter_listed_models(
                    self.user(), ["owner/model"]
                )
        self.assertEqual(kept, ())

    async def test_policy_failure_on_listing_is_503(self) -> None:
        class Down:
            async def accessible(self, **kwargs):
                raise resource_sharing.ResourceUnavailable()

        with mock.patch.object(resource_discovery, "authorizer", return_value=Down()):
            with self.assertRaises(Exception) as caught:
                await resource_discovery.resource_sharing_logger.async_filter_listed_models(
                    self.user(), ["owner/model"]
                )
        self.assertEqual(str(getattr(caught.exception, "code", None)), "503")

    async def test_admin_and_unmarked_identities_are_not_filtered(self) -> None:
        policy = FakePolicy({"__accessible__": ()})
        with mock.patch.object(resource_discovery, "authorizer", return_value=policy):
            names = ["owner/model"]
            admin = self.user(role="proxy_admin")
            self.assertEqual(
                await resource_discovery.resource_sharing_logger.async_filter_listed_models(admin, names),
                names,
            )
            unmarked = self.user(metadata={"azp": "client-a"})
            self.assertEqual(
                await resource_discovery.resource_sharing_logger.async_filter_listed_models(unmarked, names),
                names,
            )

    def test_agent_entries_are_filtered_by_canonical_name(self) -> None:
        agents = [
            type("Agent", (), {"agent_name": "owner/workflow"})(),
            type("Agent", (), {"agent_name": "owner/other"})(),
        ]
        self.assertEqual(
            resource_discovery.filter_agent_entries(agents, frozenset({"owner/workflow"})),
            (agents[0],),
        )

    def test_logger_does_not_hook_billing_or_streaming_callbacks(self) -> None:
        """M2 must leave wallet and streaming/error accounting untouched."""
        for name in (
            "async_pre_call_hook",
            "async_post_call_success_hook",
            "async_post_call_failure_hook",
            "async_log_success_event",
            "async_log_failure_event",
        ):
            self.assertNotIn(
                name,
                resource_discovery.ResourceSharingLogger.__dict__,
                f"{name} would change wallet/streaming semantics",
            )

    def test_mcp_entries_are_filtered_by_server_name_or_alias(self) -> None:
        servers = [
            type("Server", (), {"server_name": "owner/mcp", "alias": None})(),
            type("Server", (), {"server_name": "owner/other", "alias": "owner/mcp-alias"})(),
            type("Server", (), {"server_name": "owner/hidden", "alias": None})(),
        ]
        kept = resource_discovery.filter_mcp_server_entries(
            servers, frozenset({"owner/mcp", "owner/mcp-alias"})
        )
        self.assertEqual(kept, [servers[0], servers[1]])


if __name__ == "__main__":
    unittest.main()
