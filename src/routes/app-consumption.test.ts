import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { ERR } from "../errors.js";

import type * as ConsumptionModule from "../services/consumption.js";
const { mockRequireApplication, mockRecord, mockList, mockGet } = vi.hoisted(
  () => ({
    mockRequireApplication: vi.fn(),
    mockRecord: vi.fn(),
    mockList: vi.fn(),
    mockGet: vi.fn(),
  }),
);

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineApplication: mockRequireApplication,
}));
vi.mock("../services/consumption.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConsumptionModule>()),
  recordConsumption: mockRecord,
  listConsumption: mockList,
  getConsumption: mockGet,
}));

const { appConsumptionRoutes } = await import("./app-consumption.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(appConsumptionRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  mockRequireApplication
    .mockReset()
    .mockResolvedValue({ applicationId: "app-uuid", clientId: "my-app" });
  mockRecord.mockReset().mockResolvedValue({
    metered: false,
    aggregate: { key: "docs", total: "3" },
  });
  mockList.mockReset().mockResolvedValue([]);
  mockGet.mockReset().mockResolvedValue({
    key: "docs",
    total: "3",
    updatedAt: new Date("2026-10-31T08:00:00.000Z"),
  });
});

const post = (payload: unknown, url = "/users/u1") =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: "Bearer t" },
    payload: payload as Record<string, unknown>,
  });

describe("POST /users/:userId", () => {
  it("records usage for the application behind the token", async () => {
    const res = await post({ key: "docs", value: 2, idempotencyKey: "r1" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      aggregate: { key: "docs", total: "3" },
    });
    expect(mockRequireApplication).toHaveBeenCalledWith(
      "Bearer t",
      "consumption:write",
    );
    expect(mockRecord).toHaveBeenCalledWith({
      userId: "u1",
      applicationId: "app-uuid",
      key: "docs",
      value: 2,
      idempotencyKey: "r1",
    });
  });

  it("flags a metered key", async () => {
    mockRecord.mockResolvedValue({
      metered: true,
      aggregate: { key: "ai", total: "9" },
    });
    const res = await post({ key: "ai", value: 1 });
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      metered: true,
      aggregate: { key: "ai", total: "9" },
    });
  });

  it("ignores an application id sent in the body", async () => {
    await post({ key: "docs", value: 1, applicationId: "someone-else" });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "app-uuid" }),
    );
  });

  it("answers CONS_001 for a bad key and CONS_002 for a bad value", async () => {
    const badKey = await post({ key: "a-b", value: 1 });
    expect(badKey.statusCode).toBe(400);
    expect(JSON.parse(badKey.body).error.code).toBe("CONS_001");

    const badValue = await post({ key: "docs", value: "1" });
    expect(badValue.statusCode).toBe(400);
    expect(JSON.parse(badValue.body).error.code).toBe("CONS_002");
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects a caller without the scope before reading the body", async () => {
    mockRequireApplication.mockRejectedValue(
      ERR.AUTH_011("Missing required scope: consumption:write"),
    );
    const res = await post({ key: "docs", value: 1 });
    expect(res.statusCode).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects a missing token", async () => {
    mockRequireApplication.mockRejectedValue(ERR.AUTH_001());
    expect((await post({ key: "docs", value: 1 })).statusCode).toBe(401);
  });
});

describe("GET /users/:userId", () => {
  it("lists the totals of the application", async () => {
    mockList.mockResolvedValue([
      {
        key: "docs",
        total: "3",
        updatedAt: new Date("2026-10-31T08:00:00.000Z"),
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/users/u1",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      aggregates: [
        { key: "docs", total: "3", updatedAt: "2026-10-31T08:00:00.000Z" },
      ],
    });
    expect(mockRequireApplication).toHaveBeenCalledWith(
      "Bearer t",
      "consumption:read",
    );
    expect(mockList).toHaveBeenCalledWith("u1", "app-uuid");
  });
});

describe("GET /users/:userId/:key", () => {
  it("reads one total", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/u1/docs",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).aggregate.total).toBe("3");
    expect(mockGet).toHaveBeenCalledWith("u1", "app-uuid", "docs");
  });

  it("answers 404 for an unknown key", async () => {
    mockGet.mockRejectedValue(ERR.CONS_003("Consumption record not found"));
    const res = await app.inject({
      method: "GET",
      url: "/users/u1/ghost",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid key before any lookup", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/u1/a-b",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
