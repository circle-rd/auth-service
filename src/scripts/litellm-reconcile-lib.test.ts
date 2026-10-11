import { describe, expect, it } from "vitest";
import {
  isClean,
  parseSpendLogs,
  reconcile,
  type GatewayLogEntry,
  type LedgerEntry,
} from "./litellm-reconcile-lib.js";

const T0 = new Date("2026-10-11T10:00:00Z");
const window = {
  from: new Date("2026-10-11T00:00:00Z"),
  settledBefore: new Date("2026-10-11T11:50:00Z"),
};

const log = (requestId: string, over: Partial<GatewayLogEntry> = {}) => ({
  requestId,
  userId: "u1",
  costUsd: 0.0001,
  startedAt: T0,
  ...over,
});

const ledger = (
  requestId: string | null,
  over: Partial<LedgerEntry> = {},
): LedgerEntry => ({
  requestId,
  userId: "u1",
  amount: "111",
  costUsd: "0.000100000000",
  createdAt: T0,
  ...over,
});

describe("parseSpendLogs", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    call_type: "acompletion",
    spend: 0.5,
    user: "u1",
    startTime: "2026-10-11T10:00:00+00:00",
    metadata: { litellm_call_id: "c1" },
    ...over,
  });

  it("keeps billable user calls", () => {
    expect(parseSpendLogs([row()])).toEqual([
      {
        requestId: "c1",
        userId: "u1",
        costUsd: 0.5,
        startedAt: new Date("2026-10-11T10:00:00Z"),
      },
    ]);
  });

  it("ignores service traffic and free calls", () => {
    expect(parseSpendLogs([row({ user: null }), row({ spend: 0 })])).toEqual(
      [],
    );
  });

  it("rejects a billable row it cannot identify", () => {
    expect(() => parseSpendLogs([row({ metadata: {} })])).toThrow(
      /litellm_call_id/,
    );
  });

  it("rejects a malformed row instead of skipping it", () => {
    expect(() => parseSpendLogs([{ spend: 1 }])).toThrow();
  });
});

describe("reconcile", () => {
  it("matches a call with its charge", () => {
    const report = reconcile([log("c1")], [ledger("c1")], window);
    expect(report.matched).toBe(1);
    expect(isClean(report)).toBe(true);
  });

  it("reports a settled call that was never charged", () => {
    const report = reconcile([log("c1")], [], window);
    expect(report.unbilled.map((l) => l.requestId)).toEqual(["c1"]);
    expect(isClean(report)).toBe(false);
  });

  it("waits for a recent call, and ignores one before the window", () => {
    const recent = log("c1", { startedAt: new Date("2026-10-11T11:55:00Z") });
    const early = log("c2", { startedAt: new Date("2026-10-10T23:30:00Z") });
    expect(isClean(reconcile([recent, early], [], window))).toBe(true);
  });

  it("reports a different cost or a different user", () => {
    const cost = reconcile(
      [log("c1")],
      [ledger("c1", { costUsd: "0.5" })],
      window,
    );
    const owner = reconcile(
      [log("c1")],
      [ledger("c1", { userId: "u2" })],
      window,
    );
    expect(cost.mismatched).toHaveLength(1);
    expect(owner.mismatched).toHaveLength(1);
  });

  it("tolerates floating point noise in the cost", () => {
    const report = reconcile(
      [log("c1", { costUsd: 9.999999999999999e-5 })],
      [ledger("c1")],
      window,
    );
    expect(report.matched).toBe(1);
  });

  it("reports a charge without a gateway call, or without a call id", () => {
    const report = reconcile([], [ledger("ghost"), ledger(null)], window);
    expect(report.orphaned).toHaveLength(2);
  });

  it("does not call a recent charge an orphan: spend logs are written late", () => {
    const fresh = ledger("c9", { createdAt: new Date("2026-10-11T11:59:00Z") });
    expect(isClean(reconcile([], [fresh], window))).toBe(true);
  });

  it("reports a call charged twice", () => {
    const report = reconcile([log("c1")], [ledger("c1"), ledger("c1")], window);
    expect(report.duplicated).toEqual(["c1"]);
  });
});
