import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../../tests/helpers/app.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession, mockSecurity, mockEvents, mockBusiness } = vi.hoisted(
  () => ({
    mockGetSession: vi.fn(),
    mockSecurity: vi.fn(),
    mockEvents: vi.fn(),
    mockBusiness: vi.fn(),
  }),
);

vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("../../services/resources/monitoring.js", () => ({
  getSecurityStats: mockSecurity,
  listAdminAccessEvents: mockEvents,
}));
vi.mock("../../services/billing/mrr.js", () => ({
  getBusinessStats: mockBusiness,
}));

const { monitoringRoutes } = await import("./monitoring.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(monitoringRoutes, { prefix: "/api/admin/monitoring" });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const mock of [mockGetSession, mockSecurity, mockEvents, mockBusiness]) {
    mock.mockReset();
  }
  mockSecurity.mockResolvedValue({ range: "7d" });
  mockEvents.mockResolvedValue({
    events: [],
    hasMore: false,
    nextOffset: null,
  });
  mockBusiness.mockResolvedValue({ mrr: 0 });
});

const ROUTES = ["security", "access-events", "business"] as const;

describe("monitoring routes access", () => {
  for (const route of ROUTES) {
    it(`${route}: rejects anonymous callers`, async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/monitoring/${route}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it(`${route}: rejects a regular user`, async () => {
      mockGetSession.mockResolvedValue({ user: { id: "u", role: "user" } });
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/monitoring/${route}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it(`${route}: accepts an admin, also when roles are a list`, async () => {
      for (const role of ["admin", "superadmin", "user,admin"]) {
        mockGetSession.mockResolvedValue({ user: { id: "a", role } });
        const res = await app.inject({
          method: "GET",
          url: `/api/admin/monitoring/${route}`,
        });
        expect(res.statusCode).toBe(200);
      }
    });
  }
});

describe("monitoring routes validation", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: "a", role: "admin" } });
  });

  it("passes the requested range to the security stats", async () => {
    await app.inject({
      method: "GET",
      url: "/api/admin/monitoring/security?range=30d",
    });
    expect(mockSecurity).toHaveBeenCalledWith("30d");
  });

  it("refuses an unknown range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/monitoring/security?range=90d",
    });
    expect(res.statusCode).toBe(400);
    expect(mockSecurity).not.toHaveBeenCalled();
  });

  it("refuses an oversized page", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/monitoring/access-events?limit=5000",
    });
    expect(res.statusCode).toBe(400);
    expect(mockEvents).not.toHaveBeenCalled();
  });

  it("forwards the decision filter", async () => {
    await app.inject({
      method: "GET",
      url: "/api/admin/monitoring/access-events?decision=deny&limit=10",
    });
    expect(mockEvents).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny", limit: 10, offset: 0 }),
    );
  });
});
