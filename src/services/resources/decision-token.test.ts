import { describe, expect, it } from "vitest";
import {
  DECISION_CLOCK_LEEWAY_S,
  assertStartedWithinDecision,
  signDecision,
  verifyDecision,
} from "./decision-token.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const base = { sub: "user-1", app: "consumer-app", by: "litellm", now: NOW };

describe("gateway decision token", () => {
  it("round-trips the subject, application and holder", () => {
    const { decisionId, expiresAt } = signDecision(base);
    const payload = verifyDecision(decisionId);
    expect(payload).toMatchObject({
      sub: "user-1",
      app: "consumer-app",
      by: "litellm",
    });
    expect(payload.exp - payload.iat).toBe(60);
    expect(expiresAt.getTime()).toBe(payload.exp * 1000);
  });

  it("is capped by the end of the user token", () => {
    const notAfter = Math.floor(NOW.getTime() / 1000) + 10;
    const { decisionId } = signDecision({ ...base, notAfter });
    expect(verifyDecision(decisionId).exp).toBe(notAfter);
  });

  it("rejects a tampered payload, signature or shape", () => {
    const { decisionId } = signDecision(base);
    const [body, signature] = decisionId.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...verifyDecision(decisionId), app: "other-app" }),
    ).toString("base64url");
    for (const bad of [
      `${forged}.${signature}`,
      `${body}.${"A".repeat(signature.length)}`,
      `${body}.`,
      body,
      `${decisionId}.extra`,
      "",
    ]) {
      expect(() => verifyDecision(bad)).toThrowError(/Invalid decision/);
    }
  });

  it("accepts a request that started inside the window, with skew", () => {
    const decision = verifyDecision(signDecision(base).decisionId);
    const inside = new Date(NOW.getTime() + 20_000);
    expect(() => assertStartedWithinDecision(decision, inside)).not.toThrow();
    const skewed = new Date(
      NOW.getTime() - (DECISION_CLOCK_LEEWAY_S - 1) * 1000,
    );
    expect(() => assertStartedWithinDecision(decision, skewed)).not.toThrow();
  });

  it("refuses a request that started before or well after the decision", () => {
    const decision = verifyDecision(signDecision(base).decisionId);
    const before = new Date(
      NOW.getTime() - (DECISION_CLOCK_LEEWAY_S + 5) * 1000,
    );
    const after = new Date((decision.exp + DECISION_CLOCK_LEEWAY_S + 5) * 1000);
    expect(() => assertStartedWithinDecision(decision, before)).toThrow();
    expect(() => assertStartedWithinDecision(decision, after)).toThrow();
  });
});
