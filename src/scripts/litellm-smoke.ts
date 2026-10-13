import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AuthAdminClient,
  WALLET_CLIENT_SLUG,
  WALLET_SCOPES,
  decodeJwtClaims,
  loadScriptEnv,
  type AdminApplication,
} from "./litellm-lib.js";

const REDIRECT_URI = "http://localhost:9/callback";
const MOCK_MODEL = "llm-smoke-mock";

const modelCreatedSchema = z.object({
  model_id: z.string().optional(),
  model_info: z.object({ id: z.string() }).optional(),
});
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

// Credit given to the smoke user when it has too little, in micro-euros (5 EUR).
const SMOKE_CREDIT = 5_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds, for at most `seconds`. */
async function eventually(
  check: () => Promise<boolean>,
  seconds: number,
): Promise<boolean> {
  for (let i = 0; i < seconds; i += 1) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

const teamInfoSchema = z.object({
  team_info: z.object({
    blocked: z.boolean().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
});

const uiSessionSchema = z.object({ key: z.string().startsWith("sk-") });

const walletBalanceSchema = z.object({
  balance: z.string().regex(/^[0-9]+$/),
  currency: z.literal("eur"),
});

let failures = 0;

function report(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}\n`,
  );
}

async function expectStatus(
  label: string,
  expected: number,
  call: () => Promise<Response>,
): Promise<Response> {
  const res = await call();
  report(
    res.status === expected,
    label,
    `HTTP ${res.status}, expected ${expected}`,
  );
  return res;
}

async function main(): Promise<void> {
  const env = loadScriptEnv();
  if (!env.LITELLM_MASTER_KEY)
    throw new Error("LITELLM_MASTER_KEY is required (run pnpm llm:setup)");
  const masterKey = env.LITELLM_MASTER_KEY;
  const gatewayUrl = env.LITELLM_PUBLIC_URL;

  const admin = new AuthAdminClient(env.authUrl, env.BETTER_AUTH_URL);
  await admin.signIn(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

  const suffix = randomBytes(4).toString("hex");
  const created: AdminApplication[] = [];
  let modelId: string | undefined;
  const litellm = (
    path: string,
    token: string | null,
    init: RequestInit = {},
  ) =>
    fetch(`${env.litellmUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  const chat = (token: string | null, headers?: Record<string, string>) =>
    litellm("/v1/chat/completions", token, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

  try {
    const base = {
      skipConsent: true,
      redirectUris: [REDIRECT_URI],
      allowedResources: [gatewayUrl],
    };
    const publicApp = await admin.createApplication({
      ...base,
      name: `LLM smoke public ${suffix}`,
      slug: `llm-smoke-public-${suffix}`,
      isPublic: true,
    });
    created.push(publicApp.application);
    const privateApp = await admin.createApplication({
      ...base,
      name: `LLM smoke private ${suffix}`,
      slug: `llm-smoke-private-${suffix}`,
      url: `https://llm-smoke-private-${suffix}.invalid`,
    });
    created.push(privateApp.application);
    const privateSecret = privateApp.clientSecret;
    if (!privateSecret)
      throw new Error("Private application returned no client secret");

    const modelRes = await litellm("/model/new", masterKey, {
      method: "POST",
      body: JSON.stringify({
        model_name: MOCK_MODEL,
        litellm_params: {
          model: `openai/${MOCK_MODEL}`,
          api_key: "unused",
          mock_response: "pong",
          // A priced model, so that a call has a cost to bill.
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000004,
        },
      }),
    });
    if (!modelRes.ok)
      throw new Error(
        `Mock model creation failed: HTTP ${modelRes.status} ${await modelRes.text()}`,
      );
    const model = modelCreatedSchema.parse(await modelRes.json());
    modelId = model.model_info?.id ?? model.model_id;

    const publicToken = await admin.requestUserToken({
      clientId: publicApp.application.slug,
      redirectUri: REDIRECT_URI,
      resource: gatewayUrl,
    });
    const privateToken = await admin.requestUserToken({
      clientId: privateApp.application.slug,
      clientSecret: privateSecret,
      redirectUri: REDIRECT_URI,
      resource: gatewayUrl,
    });
    const claims = decodeJwtClaims(publicToken);
    report(
      claims.azp === publicApp.application.slug,
      "token carries azp = calling application",
    );

    // Each application with LiteLLM support got its own gateway team, closed until
    // a gateway administrator grants it models (done here with the master key).
    const team = async (slug: string) => {
      const res = await litellm(
        `/team/info?team_id=${encodeURIComponent(slug)}`,
        masterKey,
      );
      return res.ok ? teamInfoSchema.parse(await res.json()).team_info : null;
    };
    const privateSlug = privateApp.application.slug;
    const publicSlug = publicApp.application.slug;
    report(
      (await team(privateSlug))?.metadata?.managed_by === "auth-service",
      "creating an application with LiteLLM support creates its gateway team",
    );
    await expectStatus(
      "a new application's team is closed until models are granted",
      403,
      () => chat(privateToken),
    );
    for (const slug of [privateSlug, publicSlug]) {
      const grant = await litellm("/team/update", masterKey, {
        method: "POST",
        body: JSON.stringify({ team_id: slug, models: [MOCK_MODEL] }),
      });
      report(grant.ok, `models granted to the team of ${slug}`);
    }
    // The gateway caches teams for about a minute.
    report(
      await eventually(
        async () => (await chat(privateToken)).status === 200,
        90,
      ),
      "a team with a granted model can call it",
    );

    // The smoke user needs credit: the gateway refuses a call without any.
    const userId = z.string().parse(claims.sub);
    const start = await admin.getWallet(userId);
    if (!start.canSpend || start.balance < SMOKE_CREDIT / 2n) {
      await admin.topUp(
        userId,
        SMOKE_CREDIT,
        "llm-smoke",
        `llm-smoke-${suffix}-credit`,
      );
    }
    const before = (await admin.getWallet(userId)).balance;

    await expectStatus("public app user token → /v1/models", 200, () =>
      litellm("/v1/models", publicToken),
    );
    const completion = await expectStatus(
      "public app user token → completion",
      200,
      () => chat(publicToken),
    );
    if (completion.ok) {
      const content = completionSchema.parse(await completion.json()).choices[0]
        ?.message.content;
      report(
        content === "pong",
        "completion content comes from the mock model",
      );
    }
    await expectStatus("private app user token → completion", 200, () =>
      chat(privateToken),
    );
    report(
      await eventually(
        async () => (await admin.getWallet(userId)).balance < before,
        15,
      ),
      "chat calls are billed to the user's wallet",
    );
    await expectStatus("master key → /v1/models", 200, () =>
      litellm("/v1/models", masterKey),
    );

    // A user token only reaches the LLM and MCP routes: administration stays on
    // the master key, otherwise a user could mint LiteLLM keys that bypass
    // auth-service.
    for (const [path, body] of [
      ["/key/generate", {}],
      ["/user/new", { user_email: "smoke@example.invalid" }],
      ["/team/new", { team_alias: "smoke" }],
    ] as const) {
      await expectStatus(`user token cannot call ${path}`, 403, () =>
        litellm(path, publicToken, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    }
    await expectStatus("user token cannot read the spend logs", 403, () =>
      litellm("/spend/logs", publicToken),
    );

    // Virtual keys are LiteLLM's own: the auth hook must let them through. With
    // the sign-in through auth-service on, the shared master-key login of the
    // admin UI must be closed, so a key is minted over the API instead.
    const login = await fetch(`${env.litellmUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: masterKey }),
      redirect: "manual",
    });
    const sessionCookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith("token="));
    if (env.LITELLM_SSO_ENABLED === "true") {
      report(
        sessionCookie === undefined,
        "the master key no longer signs in to the admin UI",
        `HTTP ${login.status}`,
      );
    } else {
      const uiKey = sessionCookie
        ? uiSessionSchema.safeParse(
            decodeJwtClaims(sessionCookie.slice(6).split(";")[0] ?? ""),
          )
        : undefined;
      report(uiKey?.success === true, "admin UI sign-in returns a session key");
      if (uiKey?.success) {
        await expectStatus("admin UI session key → /v2/model/info", 200, () =>
          litellm("/v2/model/info", uiKey.data.key),
        );
      }
    }
    const generated = await litellm("/key/generate", masterKey, {
      method: "POST",
      body: JSON.stringify({ key_alias: `llm-smoke-${suffix}` }),
    });
    const virtualKey = z
      .object({ key: z.string().startsWith("sk-") })
      .safeParse(await generated.json());
    report(virtualKey.success, "the master key can mint a virtual key");
    if (virtualKey.success) {
      await expectStatus("a virtual key → /v1/models", 200, () =>
        litellm("/v1/models", virtualKey.data.key),
      );
      await litellm("/key/delete", masterKey, {
        method: "POST",
        body: JSON.stringify({ keys: [virtualKey.data.key] }),
      });
    }
    await expectStatus("an unknown virtual key is refused", 401, () =>
      litellm("/v1/models", "sk-not-a-real-key-0123456789"),
    );

    const clientCredentials = await admin.requestClientCredentialsToken({
      clientId: privateApp.application.slug,
      clientSecret: privateSecret,
      resource: gatewayUrl,
    });
    await expectStatus("client_credentials token is rejected", 401, () =>
      chat(clientCredentials),
    );
    const otherAudience = await admin.requestClientCredentialsToken({
      clientId: privateApp.application.slug,
      clientSecret: privateSecret,
      resource: `https://llm-smoke-private-${suffix}.invalid`,
    });
    await expectStatus("wrong audience is rejected", 401, () =>
      chat(otherAudience),
    );
    await expectStatus("tampered signature is rejected", 401, () =>
      chat(`${publicToken.slice(0, -4)}AAAA`),
    );
    await expectStatus("garbage token is rejected", 401, () =>
      chat("not-a-jwt"),
    );
    await expectStatus("missing token is rejected", 401, () => chat(null));
    // Wallet API (auth-service). Authorization checks only: no money moves, so
    // the append-only ledger is left untouched.
    const walletSecret = env.LITELLM_WALLET_CLIENT_SECRET;
    if (!walletSecret) {
      throw new Error(
        "LITELLM_WALLET_CLIENT_SECRET is required (run pnpm llm:setup)",
      );
    }
    const walletToken = await admin.requestClientCredentialsToken({
      clientId: WALLET_CLIENT_SLUG,
      clientSecret: walletSecret,
      scope: WALLET_SCOPES.join(" "),
    });
    const wallet = (
      path: string,
      token: string | null,
      init: RequestInit = {},
    ) =>
      fetch(`${env.authUrl}/api/internal/wallet${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    const balance = await expectStatus(
      "wallet: gateway credentials read a balance",
      200,
      () => wallet(`/users/${userId}`, walletToken),
    );
    if (balance.ok) {
      const body = walletBalanceSchema.safeParse(await balance.json());
      report(body.success, "wallet: balance is an integer string in euros");
    }
    await expectStatus(
      "wallet: invalid usage is rejected before any debit",
      400,
      () =>
        wallet(`/users/${userId}/usage`, walletToken, {
          method: "POST",
          body: JSON.stringify({ amount: "0", idempotencyKey: "smoke" }),
        }),
    );
    await expectStatus("wallet: generic m2m token is refused", 403, () =>
      wallet(`/users/${userId}`, clientCredentials),
    );
    await expectStatus("wallet: user-bound token is refused", 403, () =>
      wallet(`/users/${userId}`, publicToken),
    );
    await expectStatus("wallet: missing token is refused", 401, () =>
      wallet(`/users/${userId}`, null),
    );

    // Debt blocks the next call; a top-up unblocks it. The gateway keeps a
    // balance for a few seconds, hence the pauses.
    const current = (await admin.getWallet(userId)).balance;
    const debt = await wallet(`/users/${userId}/usage`, walletToken, {
      method: "POST",
      body: JSON.stringify({
        amount: (current + 1000n).toString(),
        idempotencyKey: `llm-smoke-${suffix}-debt`,
      }),
    });
    report(debt.status === 201, "usage beyond the balance is recorded as debt");
    await sleep(6000);
    await expectStatus("a user in debt is refused with 402", 402, () =>
      chat(publicToken),
    );
    await admin.topUp(
      userId,
      SMOKE_CREDIT,
      "llm-smoke",
      `llm-smoke-${suffix}-repay`,
    );
    await sleep(6000);
    await expectStatus("the user can call again after a top-up", 200, () =>
      chat(publicToken),
    );

    // Every call frees its concurrency slot: more sequential calls than the
    // simultaneous-call ceiling (default 8) must all pass.
    let sequentialOk = true;
    for (let i = 0; i < 12; i += 1) {
      sequentialOk = (await chat(publicToken)).status === 200 && sequentialOk;
    }
    report(sequentialOk, "sequential calls beyond the concurrency ceiling");

    // The call id is client-controlled: reusing it must never make a call free.
    const beforeSpoof = (await admin.getWallet(userId)).balance;
    for (let i = 0; i < 3; i += 1) {
      await chat(publicToken, { "x-litellm-call-id": "llm-smoke-fixed-id" });
    }
    report(
      await eventually(
        async () =>
          (await admin.getWallet(userId)).balance <= beforeSpoof - 3n * 100n,
        15,
      ),
      "calls sharing a client-chosen call id are all billed",
    );

    // Losing the LiteLLM support blocks the team; deleting the application removes it.
    await admin.updateApplication(privateApp.application.id, {
      allowedResources: [],
    });
    report(
      (await team(privateSlug))?.blocked === true,
      "removing the LiteLLM support blocks the application's team",
    );
    await admin.deleteApplication(privateApp.application.id);
    created.splice(created.indexOf(privateApp.application), 1);
    report(
      (await team(privateSlug)) === null,
      "deleting the application deletes its team",
    );
  } finally {
    if (modelId) {
      await litellm("/model/delete", masterKey, {
        method: "POST",
        body: JSON.stringify({ id: modelId }),
      });
    }
    for (const app of created) await admin.deleteApplication(app.id);
    await admin.signOut();
  }

  process.stdout.write(
    failures === 0
      ? "\nAll checks passed\n"
      : `\n${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
