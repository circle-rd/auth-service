import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type * as BetterAuthModule from "better-auth";
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { oauthClientResource } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
let generatedIds = 0;
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof BetterAuthModule>();
  return { ...actual, generateId: vi.fn(() => `res-oauth-id-${++generatedIds}`) };
});

const GATEWAY_URL = "https://llm.example.com";
const app = createTestApp();

beforeAll(async () => {
  await app.register(applicationRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession() as unknown as Awaited<
      ReturnType<typeof auth.api.getSession>
    >,
  );
});

async function createApplication(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/", payload });
}

async function linkedResources(clientId: string): Promise<string[]> {
  const rows = await db
    .select({ resourceId: oauthClientResource.resourceId })
    .from(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));
  return rows.map((r) => r.resourceId).sort();
}

async function createGatewayAndClient(): Promise<string> {
  const gateway = await createApplication({
    name: "Gateway",
    slug: "gateway",
    url: GATEWAY_URL,
  });
  expect(gateway.statusCode).toBe(201);
  const client = await createApplication({
    name: "Client",
    slug: "client",
    url: "https://client.example.com",
    allowedResources: [GATEWAY_URL],
  });
  expect(client.statusCode).toBe(201);
  return client.json<{ application: { id: string } }>().application.id;
}

describe("application allowedResources", () => {
  it("links the client to its own URL and to every allowed resource", async () => {
    await createGatewayAndClient();
    expect(await linkedResources("client")).toEqual(
      [GATEWAY_URL, "https://client.example.com"].sort(),
    );
    expect(await linkedResources("gateway")).toEqual([GATEWAY_URL]);
  });

  it("exposes allowedResources in the application view", async () => {
    const id = await createGatewayAndClient();
    const res = await app.inject({ method: "GET", url: `/${id}` });
    expect(
      res.json<{ application: { allowedResources: string[] } }>().application
        .allowedResources,
    ).toEqual([GATEWAY_URL]);
  });

  it("keeps the links when an update omits allowedResources", async () => {
    const id = await createGatewayAndClient();
    const res = await app.inject({
      method: "PATCH",
      url: `/${id}`,
      payload: { name: "Client renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ application: { allowedResources: string[] } }>().application
        .allowedResources,
    ).toEqual([GATEWAY_URL]);
    expect(await linkedResources("client")).toContain(GATEWAY_URL);
  });

  it("removes the link when allowedResources is emptied", async () => {
    const id = await createGatewayAndClient();
    const res = await app.inject({
      method: "PATCH",
      url: `/${id}`,
      payload: { allowedResources: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(await linkedResources("client")).toEqual([
      "https://client.example.com",
    ]);
  });

  it("de-duplicates the submitted list", async () => {
    await createApplication({ name: "Gateway", slug: "gateway", url: GATEWAY_URL });
    const res = await createApplication({
      name: "Client",
      slug: "client",
      allowedResources: [GATEWAY_URL, GATEWAY_URL],
    });
    expect(res.statusCode).toBe(201);
    expect(
      res.json<{ application: { allowedResources: string[] } }>().application
        .allowedResources,
    ).toEqual([GATEWAY_URL]);
  });

  it("rejects an unknown resource on create", async () => {
    const res = await createApplication({
      name: "Client",
      slug: "client",
      allowedResources: ["https://unknown.example.com"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_001");
  });

  it("rejects an unknown resource on update", async () => {
    const id = await createGatewayAndClient();
    const res = await app.inject({
      method: "PATCH",
      url: `/${id}`,
      payload: { allowedResources: ["https://unknown.example.com"] },
    });
    expect(res.statusCode).toBe(400);
    expect(await linkedResources("client")).toContain(GATEWAY_URL);
  });

  it("rejects the application's own URL", async () => {
    const id = await createGatewayAndClient();
    const res = await app.inject({
      method: "PATCH",
      url: `/${id}`,
      payload: { allowedResources: ["https://client.example.com"] },
    });
    expect(res.statusCode).toBe(400);
  });
});
