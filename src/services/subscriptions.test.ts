import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../errors.js";

const { mockDb, state, publishEvent } = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserts: [] as { table: unknown; values: Record<string, unknown> }[],
    updates: [] as Record<string, unknown>[],
    deletes: [] as unknown[],
  };

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        return {
          onConflictDoUpdate: (cfg: unknown) => {
            state.updates.push({ onConflictDoUpdate: cfg });
            return Promise.resolve();
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updates.push({ table, values });
          return Promise.resolve();
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.deletes.push(table);
        return Promise.resolve();
      },
    }),
  };

  const mockDb = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(state.selects.shift() ?? []),
      };
      return chain;
    },
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return { mockDb, state, publishEvent: vi.fn() };
});

vi.mock("../db/index.js", () => ({ db: mockDb }));
vi.mock("./event-bus.js", () => ({ publishEvent }));

const APP_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "user-1";
const PLAN_ID = "00000000-0000-0000-0000-0000000000bb";
const OLD_PLAN_ID = "00000000-0000-0000-0000-0000000000cc";

beforeEach(() => {
  // The change notifier keeps module-level throttle state; reset the module so
  // each test starts from a clean slate, and drive it with fake timers.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  vi.resetModules();
  state.selects.length = 0;
  state.inserts.length = 0;
  state.updates.length = 0;
  state.deletes.length = 0;
  publishEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  return import("./subscriptions.js");
}

function planRow() {
  return { id: PLAN_ID };
}

function current(overrides: Partial<Record<string, unknown>> = {}) {
  return { planId: null, isActive: true, expiresAt: null, ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err as ApiError;
}

function auditRows() {
  return state.inserts.filter((i) => i.values.action);
}

describe("setUserSubscription", () => {
  it("rejects a plan that does not belong to the application", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([]);
    const err = await rejection(
      setUserSubscription({
        userId: USER_ID,
        applicationId: APP_ID,
        planId: PLAN_ID,
        source: "admin",
      }),
    );
    expect(err.code).toBe("SUB_001");
    expect(state.inserts).toHaveLength(0);
  });

  it("assigns a plan, mirrors it and writes an audit entry", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([planRow()]); // plan belongs to app
    state.selects.push([]); // no current subscription

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "admin",
      actorUserId: "admin-1",
      reason: "onboarding",
    });

    expect(result).toMatchObject({
      planId: PLAN_ID,
      changed: true,
      action: "assigned",
      fromPlanId: null,
      toPlanId: PLAN_ID,
    });

    const subInsert = state.inserts.find(
      (i) => (i.values as { planId?: string }).planId === PLAN_ID,
    );
    expect(subInsert?.values).toMatchObject({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      isActive: true,
    });
    expect(auditRows()[0]?.values).toMatchObject({
      userId: USER_ID,
      applicationId: APP_ID,
      actorUserId: "admin-1",
      source: "admin",
      action: "assigned",
      fromPlanId: null,
      toPlanId: PLAN_ID,
      reason: "onboarding",
    });
    expect(publishEvent).toHaveBeenCalledWith("subscription.changed");
  });

  it("records a change when the plan already exists", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([planRow()]);
    state.selects.push([current({ planId: OLD_PLAN_ID })]);

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "self",
      actorUserId: USER_ID,
    });

    expect(result).toMatchObject({ changed: true, action: "changed" });
    expect(auditRows()[0]?.values).toMatchObject({
      fromPlanId: OLD_PLAN_ID,
      toPlanId: PLAN_ID,
      source: "self",
    });
    expect(publishEvent).toHaveBeenCalledWith("subscription.changed");
  });

  it("records an expiry change even when the plan is unchanged", async () => {
    const { setUserSubscription } = await load();
    const expiresAt = new Date("2027-01-01T00:00:00Z");
    state.selects.push([planRow()]);
    state.selects.push([current({ planId: PLAN_ID })]);

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "admin",
      actorUserId: "admin-1",
      reason: "extended",
      expiresAt,
    });

    expect(result.changed).toBe(true);
    expect(auditRows()[0]?.values).toMatchObject({
      action: "changed",
      fromPlanId: PLAN_ID,
      toPlanId: PLAN_ID,
      reason: "extended",
    });
    expect(publishEvent).toHaveBeenCalledWith("subscription.changed");
  });

  it("records a reactivation of a de-activated subscription", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([planRow()]);
    state.selects.push([current({ planId: PLAN_ID, isActive: false })]);

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "admin",
      actorUserId: "admin-1",
      reason: "customer returned",
    });

    expect(result).toMatchObject({ changed: true, action: "changed" });
    expect(auditRows()).toHaveLength(1);
    expect(publishEvent).toHaveBeenCalledWith("subscription.changed");
  });

  it("is a no-op when nothing changes", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([planRow()]);
    state.selects.push([current({ planId: PLAN_ID })]);

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "admin",
      actorUserId: "admin-1",
    });

    expect(result.changed).toBe(false);
    // The mirror is still converged, but nothing is audited or broadcast.
    expect(auditRows()).toHaveLength(0);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("removes a plan and records the removal", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([current({ planId: OLD_PLAN_ID })]);

    const result = await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: null,
      source: "admin",
      actorUserId: "admin-1",
    });

    expect(result).toMatchObject({
      planId: null,
      changed: true,
      action: "removed",
    });
    expect(state.deletes).toHaveLength(1);
    expect(auditRows()[0]?.values).toMatchObject({
      source: "admin",
      toPlanId: null,
    });
  });

  it("does not notify the bus for the automatic default path", async () => {
    const { setUserSubscription } = await load();
    state.selects.push([planRow()]);
    state.selects.push([]);

    await setUserSubscription({
      userId: USER_ID,
      applicationId: APP_ID,
      planId: PLAN_ID,
      source: "default",
    });

    expect(publishEvent).not.toHaveBeenCalled();
    expect(state.inserts.some((i) => i.values.source === "default")).toBe(true);
  });

  it("collapses a burst of changes into one immediate and one trailing event", async () => {
    const { setUserSubscription } = await load();
    for (let i = 0; i < 20; i += 1) {
      state.selects.push([planRow()]);
      state.selects.push([current({ planId: OLD_PLAN_ID })]);
      await setUserSubscription({
        userId: USER_ID,
        applicationId: APP_ID,
        planId: PLAN_ID,
        source: "admin",
        actorUserId: "admin-1",
        reason: "bulk",
      });
    }
    expect(publishEvent).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(publishEvent).toHaveBeenCalledTimes(2);
  });
});

describe("assignDefaultPlanIfNeeded", () => {
  it("does nothing when the application has no default plan", async () => {
    const { assignDefaultPlanIfNeeded } = await load();
    state.selects.push([]);
    await assignDefaultPlanIfNeeded(USER_ID, APP_ID);
    expect(state.inserts).toHaveLength(0);
  });

  it("does nothing when the user already holds a subscription", async () => {
    const { assignDefaultPlanIfNeeded } = await load();
    state.selects.push([planRow()]);
    state.selects.push([current({ planId: OLD_PLAN_ID })]);
    await assignDefaultPlanIfNeeded(USER_ID, APP_ID);
    expect(state.inserts).toHaveLength(0);
  });

  it("assigns the default plan without re-reading the plan or the subscription", async () => {
    const { assignDefaultPlanIfNeeded } = await load();
    state.selects.push([planRow()]); // default plan
    state.selects.push([]); // no current subscription

    await assignDefaultPlanIfNeeded(USER_ID, APP_ID);

    // Two reads total (default plan + current), no third lookup.
    expect(state.selects).toHaveLength(0);
    expect(auditRows()[0]?.values).toMatchObject({
      source: "default",
      action: "assigned",
      toPlanId: PLAN_ID,
    });
  });
});
