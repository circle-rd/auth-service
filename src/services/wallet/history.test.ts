import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = { rows: [] as unknown[], limit: 0 };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => {
      state.limit = n;
      return Promise.resolve(state.rows);
    },
  };
  return { mockDb: { select: () => chain }, state };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { listWalletTransactions, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } =
  await import("./history.js");

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

function row(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "topup",
    amount: BigInt(n),
    delta: BigInt(n),
    balanceAfter: BigInt(n),
    applicationId: null,
    metadata: {},
    createdAt: new Date(2026, 9, 9, 10, 0, n),
    position: `2026-10-09T10:00:${String(n).padStart(2, "0")}.123456Z`,
  };
}

beforeEach(() => {
  state.rows = [];
  state.limit = 0;
});

describe("listWalletTransactions", () => {
  it("fetches one extra row to know whether another page exists", async () => {
    state.rows = [row(3), row(2), row(1)];
    const page = await listWalletTransactions({
      accountId: ACCOUNT_ID,
      limit: 2,
    });
    expect(state.limit).toBe(3);
    expect(page.items.map((i) => i.amount)).toEqual(["3", "2"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns no cursor on the last page", async () => {
    state.rows = [row(2), row(1)];
    const page = await listWalletTransactions({
      accountId: ACCOUNT_ID,
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("round-trips the cursor with full timestamp precision", async () => {
    state.rows = [row(3), row(2), row(1)];
    const first = await listWalletTransactions({
      accountId: ACCOUNT_ID,
      limit: 2,
    });
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    ) as { t: string; i: string };
    expect(decoded).toEqual({ t: row(2).position, i: row(2).id });

    state.rows = [row(1)];
    const second = await listWalletTransactions({
      accountId: ACCOUNT_ID,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("applies the default and the maximum page size", async () => {
    await listWalletTransactions({ accountId: ACCOUNT_ID });
    expect(state.limit).toBe(DEFAULT_PAGE_SIZE + 1);
    await listWalletTransactions({ accountId: ACCOUNT_ID, limit: 10_000 });
    expect(state.limit).toBe(MAX_PAGE_SIZE + 1);
  });

  it.each([
    "not-base64-json",
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-10-09", i: "x" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        t: "2026-10-09T10:00:00.123456Z'; DROP TABLE x;--",
        i: row(1).id,
      }),
    ).toString("base64url"),
  ])("rejects the malformed cursor %#", async (cursor) => {
    const err = await listWalletTransactions({
      accountId: ACCOUNT_ID,
      cursor,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("WAL_005");
  });
});
