import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { consumptionRoutes } from "../routes/consumption.js";
import { verifyBearerAccessToken } from "../services/oauth-tokens.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("../auth.js", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("../services/oauth-tokens.js", () => ({
  verifyBearerAccessToken: vi.fn(),
}));
vi.mock("../db/index.js", () => ({ db: {} }));

const verifyMock = vi.mocked(verifyBearerAccessToken);

describe("consumption routes – auth and validation", () => {
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    await app.register(consumptionRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("POST / returns 400 when body is missing", async () => {
    verifyMock.mockResolvedValue({
      clientId: "test-app",
      userId: null,
      scopes: [],
    });
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: { authorization: "Bearer mock-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /:userId/:applicationId returns 400 (CONS_005) on non-uuid params", async () => {
    verifyMock.mockResolvedValue({
      clientId: "test-app",
      userId: null,
      scopes: [],
    });
    const res = await app.inject({
      method: "GET",
      url: "/undefined/undefined",
      headers: { authorization: "Bearer mock-token" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("CONS_005");
  });

  it("rejects an invalid Bearer token with 401 (fail-closed)", async () => {
    verifyMock.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: { authorization: "Bearer garbage" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a user-bound token for consumption (CONS_004)", async () => {
    verifyMock.mockResolvedValue({
      clientId: "test-app",
      userId: "user-1",
      scopes: [],
    });
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: { authorization: "Bearer user-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("CONS_004");
  });
});
