import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../../config.js";
import { ERR } from "../../errors.js";

// Gateway and auth-service run on different hosts: a small skew must not
// reject an event that was admitted a moment ago.
export const DECISION_CLOCK_LEEWAY_S = 30;

const decisionPayloadSchema = z
  .object({
    v: z.literal(1),
    // The person, the application the request came through, and the machine
    // client that obtained the decision.
    sub: z.string().min(1),
    app: z.string().min(1),
    by: z.string().min(1),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;

export interface SignedDecision {
  decisionId: string;
  expiresAt: Date;
}

function decisionKey(): Buffer {
  // Derived for this purpose only, so rotating the webhook secret or any other
  // derived key does not invalidate decisions, and the reverse.
  return createHash("sha256")
    .update(`${config.betterAuth.secret}:gateway-decision`)
    .digest();
}

function mac(body: string): Buffer {
  return createHmac("sha256", decisionKey()).update(body).digest();
}

/**
 * A signed statement that auth-service decided for `sub` through application
 * `app`, handed to machine client `by`. It never outlives `notAfter` (the end of
 * the user token it was derived from).
 */
export function signDecision(input: {
  sub: string;
  app: string;
  by: string;
  notAfter?: number | null;
  now?: Date;
}): SignedDecision {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  let exp = iat + config.resources.decisionTtlSeconds;
  if (input.notAfter != null) exp = Math.min(exp, input.notAfter);
  const payload: DecisionPayload = {
    v: 1,
    sub: input.sub,
    app: input.app,
    by: input.by,
    iat,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    decisionId: `${body}.${mac(body).toString("base64url")}`,
    expiresAt: new Date(exp * 1000),
  };
}

/** Verify the signature and shape. The caller decides what the window means. */
export function verifyDecision(decisionId: string): DecisionPayload {
  const [body, signature, extra] = decisionId.split(".");
  if (!body || !signature || extra !== undefined) {
    throw ERR.RES_016("Invalid decision");
  }
  const expected = mac(body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw ERR.RES_016("Invalid decision");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw ERR.RES_016("Invalid decision");
  }
  const parsed = decisionPayloadSchema.safeParse(json);
  if (!parsed.success) throw ERR.RES_016("Invalid decision");
  return parsed.data;
}

/** The decision must have been in force when the request started. */
export function assertStartedWithinDecision(
  decision: DecisionPayload,
  startedAt: Date,
): void {
  const started = startedAt.getTime() / 1000;
  if (
    started < decision.iat - DECISION_CLOCK_LEEWAY_S ||
    started > decision.exp + DECISION_CLOCK_LEEWAY_S
  ) {
    throw ERR.RES_016("The request did not start within the decision");
  }
}
