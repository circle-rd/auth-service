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

  const admin = new AuthAdminClient(env.authUrl);
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
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  const chat = (token: string | null) =>
    litellm("/v1/chat/completions", token, {
      method: "POST",
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
    await expectStatus("master key → /v1/models", 200, () =>
      litellm("/v1/models", masterKey),
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
    const userId = z.string().parse(claims.sub);
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
  } finally {
    if (modelId) {
      await litellm("/model/delete", masterKey, {
        method: "POST",
        body: JSON.stringify({ id: modelId }),
      });
    }
    for (const app of created) await admin.deleteApplication(app.id);
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
