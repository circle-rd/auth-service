import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { applications, loginHistory, userApplications } from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const app = createTestApp();

beforeAll(async () => {
  await app.register(applicationRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T>
  ? T
  : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession("sa-1") as unknown as SessionLike,
  );
}

async function seedApp(slug = "test-app") {
  const [a] = await db
    .insert(applications)
    .values({ name: "Test App", slug, isActive: true })
    .returning();
  return a!;
}

async function seedUser(id: string) {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedAccess(userId: string, appId: string) {
  await db
    .insert(userApplications)
    .values({ userId, applicationId: appId, isActive: true });
}

async function seedLogin(
  userId: string,
  applicationId: string | null,
  loggedAt: string,
  ipAddress: string | null = "203.0.113.9",
  userAgent: string | null = "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
) {
  await db.insert(loginHistory).values({
    userId,
    applicationId,
    loggedAt: new Date(loggedAt),
    ipAddress,
    userAgent,
  });
}

describe("admin application users — last login and history", () => {
  it("populates the last login (date, IP, device) per user from this app only", async () => {
    await seedUser("user-1");
    await seedUser("user-2");
    const a = await seedApp();
    const other = await seedApp("other-app");
    await seedAccess("user-1", a.id);
    await seedAccess("user-2", a.id);

    // user-1: two logins on this app; the newest one wins.
    await seedLogin("user-1", a.id, "2026-06-01T08:00:00.000Z");
    await seedLogin(
      "user-1",
      a.id,
      "2026-06-02T09:30:00.000Z",
      "198.51.100.7",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    // A later login on a *different* app must not surface here.
    await seedLogin("user-1", other.id, "2026-06-03T10:00:00.000Z");
    // A dashboard sign-in with no application must not surface here either.
    await seedLogin("user-1", null, "2026-06-04T11:00:00.000Z");

    asAdmin();
    const res = await app.inject({ method: "GET", url: `/${a.id}/users` });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      users: Array<{
        userId: string;
        lastLoginAt: string | null;
        lastIp: string | null;
        lastUserAgent: string | null;
      }>;
    }>();

    const u1 = body.users.find((u) => u.userId === "user-1")!;
    expect(u1.lastLoginAt).toBe("2026-06-02T09:30:00.000Z");
    expect(u1.lastIp).toBe("198.51.100.7");
    expect(u1.lastUserAgent).toContain("Windows");

    const u2 = body.users.find((u) => u.userId === "user-2")!;
    expect(u2.lastLoginAt).toBeNull();
    expect(u2.lastIp).toBeNull();
    expect(u2.lastUserAgent).toBeNull();
  });

  it("returns the paginated history entries for the user inside the app", async () => {
    await seedUser("user-1");
    const a = await seedApp();
    await seedAccess("user-1", a.id);
    await seedLogin("user-1", a.id, "2026-06-01T08:00:00.000Z");
    await seedLogin("user-1", a.id, "2026-06-02T08:00:00.000Z");
    await seedLogin("user-1", a.id, "2026-06-03T08:00:00.000Z");

    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/${a.id}/users/user-1/history?limit=2&page=1`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      total: number;
      page: number;
      limit: number;
      entries: Array<{ loggedAt: string; ipAddress: string | null }>;
    }>();
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.entries).toHaveLength(2);
    // Newest first.
    expect(body.entries[0]!.loggedAt).toBe("2026-06-03T08:00:00.000Z");
    expect(body.entries[0]!.ipAddress).toBe("203.0.113.9");
  });
});
