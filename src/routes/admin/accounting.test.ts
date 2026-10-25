import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import Fastify from "fastify";
import type * as AccountingJournalModule from "../../services/accounting-journal.js";
import { globalErrorHandler } from "../../error-handler.js";
import { accountingRoutes } from "./accounting.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession, mockListJournal } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockListJournal: vi.fn(),
}));

vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../services/accounting-journal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AccountingJournalModule>()),
  listJournal: mockListJournal,
}));

const adminSession = { user: { id: "admin-1", role: "admin" } };
const EMPTY_PAGE = { entries: [], total: 0, page: 1, limit: 25 };

describe("Admin — accountingRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.setErrorHandler(globalErrorHandler);
    await app.register(accountingRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    mockListJournal.mockReset();
    mockListJournal.mockResolvedValue(EMPTY_PAGE);
  });

  it("401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/journal" });
    expect(res.statusCode).toBe(401);
    expect(mockListJournal).not.toHaveBeenCalled();
  });

  it("403 for a regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({ method: "GET", url: "/journal" });
    expect(res.statusCode).toBe(403);
  });

  it("applies the defaults and returns the page", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/journal" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY_PAGE);
    expect(mockListJournal).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });

  it("passes the parsed filters to the service", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: "/journal?kind=grant&userId=u1&from=2026-01-01T00:00:00Z&limit=10&page=2",
    });
    expect(res.statusCode).toBe(200);
    expect(mockListJournal).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      kind: "grant",
      userId: "u1",
      from: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it.each([
    ["an unknown kind", "?kind=usage"],
    ["a malformed application id", "?applicationId=nope"],
    ["an inverted range", "?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z"],
    ["a page beyond the served window", "?limit=100&page=51"],
  ])("400 on %s", async (_label, query) => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: `/journal${query}` });
    expect(res.statusCode).toBe(400);
    expect(mockListJournal).not.toHaveBeenCalled();
  });
});
