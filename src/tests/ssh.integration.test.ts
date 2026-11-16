import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications, userApplications } from "../db/schema.js";
import { session, user as userTable } from "../db/auth-schema.js";
import {
  resourceUsageRecords,
  resources,
} from "../db/resource-schema.js";
import { sshSessions } from "../db/ssh-schema.js";
import { cleanDb } from "./helpers/db.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { createResource, getResource } from "../services/resources/registry.js";
import { completeResourceValidation } from "../services/resources/validation.js";
import { createResourceGrant } from "../services/resources/grants.js";
import { authorize } from "../services/resources/policy.js";
import { generateSshIdentity } from "../services/ssh/crypto.js";
import {
  createSshMetaUser,
  getSshGatewayDetail,
  getSshOwnerDetail,
  recordSshSession,
  resolveSshTargetByMetaUser,
  setupSshTarget,
} from "../services/ssh/targets.js";
import {
  registerRecipientKey,
  resolveRecipientKeyUserId,
} from "../services/ssh/keys.js";
import { validateDeviceSession } from "../services/ssh/device.js";

const HOST_KEY = `SHA256:${"A".repeat(43)}`;

interface Seed {
  appId: string;
  ownerId: string;
  memberId: string;
  outsiderId: string;
}

async function seedUser(id: string): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seed(): Promise<Seed> {
  const [app] = await db
    .insert(applications)
    .values({
      name: "Share App",
      slug: "share-app",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!app) throw new Error("application seed failed");
  for (const id of ["owner", "member", "outsider"]) await seedUser(id);
  for (const id of ["owner", "member"]) {
    await db.insert(userApplications).values({
      userId: id,
      applicationId: app.id,
      isActive: true,
    });
  }
  await db.insert(userApplications).values({
    userId: "outsider",
    applicationId: app.id,
    isActive: false,
  });
  await syncBuiltinSchemes();
  await enableSchemeForApplication(app.id, "ssh");
  return {
    appId: app.id,
    ownerId: "owner",
    memberId: "member",
    outsiderId: "outsider",
  };
}

async function sshResource(seedData: Seed) {
  return createResource({
    applicationId: seedData.appId,
    scheme: "ssh",
    displayName: "Nuk test account",
    ownerType: "user",
    ownerId: seedData.ownerId,
  });
}

beforeEach(async () => {
  await cleanDb();
  Object.assign(config.sshGateway, {
    envelopeKey: Buffer.alloc(32, 7).toString("base64"),
    validationHost: "gateway.test",
    port: 2222,
  });
});

describe("SSH resource contract", () => {
  it("creates an opaque identity and an authorized_keys line", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    const detail = await setupSshTarget(resource.id, seedData.ownerId, {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    expect(detail.host).toBe("nuk.local");
    expect(detail.account).toBe("test");
    expect(detail.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(detail.authorizedKeysLine).toContain(`auth-service:${resource.id}`);
    expect(detail.authorizedKeysLine.startsWith("restrict,pty,from=")).toBe(true);
    expect(detail.validationCommand).toBe(
      `ssh -p 2222 validate-${resource.id}@gateway.test`,
    );

    const gateway = await getSshGatewayDetail(resource.id, seedData.ownerId);
    expect(gateway.target).toEqual({
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    expect(gateway.identity.publicKey).toBe(detail.publicKey);
    expect(gateway.identity.privateKeyCiphertext.startsWith("v1:")).toBe(true);
  });

  it("does not expose the target to a non-manager", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    await expect(
      getSshOwnerDetail(resource.id, seedData.outsiderId),
    ).rejects.toMatchObject({ code: "RES_002" });
    await expect(
      getSshOwnerDetail(resource.id, seedData.memberId),
    ).rejects.toMatchObject({ code: "RES_002" });
  });

  it("resolves a meta-user only after validation and scheme activation", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    await setupSshTarget(resource.id, seedData.ownerId, {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    await createSshMetaUser(resource.id, seedData.ownerId, "team-a");
    await expect(resolveSshTargetByMetaUser("team-a")).rejects.toMatchObject({
      code: "RES_004",
    });

    await completeResourceValidation({
      resourceId: resource.id,
      clientId: "ssh-gateway",
      result: "validated",
      evidence: { hostKeyFingerprint: HOST_KEY },
    });
    await expect(resolveSshTargetByMetaUser("team-a")).resolves.toMatchObject({
      resourceId: resource.id,
      resourceUri: resource.uri,
      applicationSlug: "share-app",
    });
    const validated = await getResource(resource.id);
    expect(validated.status).toBe("validated");
  });

  it("requires the host key fingerprint in the validation callback", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    await setupSshTarget(resource.id, seedData.ownerId, {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    await expect(
      completeResourceValidation({
        resourceId: resource.id,
        clientId: "ssh-gateway",
        result: "validated",
      }),
    ).rejects.toMatchObject({ code: "RES_001" });
  });

  it("authorizes a grantee and records a session plus usage", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    await setupSshTarget(resource.id, seedData.ownerId, {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    await completeResourceValidation({
      resourceId: resource.id,
      clientId: "ssh-gateway",
      result: "validated",
      evidence: { hostKeyFingerprint: HOST_KEY },
    });
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: seedData.memberId,
      actorUserId: seedData.ownerId,
    });
    await expect(
      authorize({
        subjectId: seedData.memberId,
        clientId: "ssh-gateway",
        resourceUri: resource.uri,
        audience: "ssh-gateway",
      }),
    ).resolves.toMatchObject({ decision: "allow" });

    const sessionId = "session-1";
    const startedAt = new Date("2026-11-15T12:00:00Z");
    const endedAt = new Date("2026-11-15T12:05:00Z");
    const result = await recordSshSession({
      resourceId: resource.id,
      resourceUri: resource.uri,
      subjectId: seedData.memberId,
      clientId: "ssh-gateway",
      sessionId,
      startedAt,
      endedAt,
      bytesIn: 10,
      bytesOut: 20,
      endReason: "client",
    });
    expect(result.replayed).toBe(false);

    const [stored] = await db
      .select()
      .from(sshSessions)
      .where(eq(sshSessions.sessionId, sessionId));
    expect(stored?.bytesIn).toBe(10);
    const usage = await db
      .select()
      .from(resourceUsageRecords)
      .where(eq(resourceUsageRecords.requestId, sessionId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.usageSource).toBe("provider");
    expect(usage[0]?.costUsd).toBe("0");

    const replay = await recordSshSession({
      resourceId: resource.id,
      resourceUri: resource.uri,
      subjectId: seedData.memberId,
      clientId: "ssh-gateway",
      sessionId,
      startedAt,
      endedAt,
      bytesIn: 10,
      bytesOut: 20,
      endReason: "client",
    });
    expect(replay.replayed).toBe(true);
    expect(
      await db
        .select()
        .from(resourceUsageRecords)
        .where(eq(resourceUsageRecords.requestId, sessionId)),
    ).toHaveLength(1);
  });

  it("maps a registered recipient key to its user", async () => {
    const seedData = await seed();
    const identity = generateSshIdentity();
    const key = await registerRecipientKey(
      seedData.memberId,
      identity.publicKey,
      "laptop",
    );
    expect(key.fingerprint).toBe(identity.fingerprint);
    await expect(resolveRecipientKeyUserId(identity.publicKey)).resolves.toBe(
      seedData.memberId,
    );
    await expect(
      registerRecipientKey(seedData.ownerId, identity.publicKey),
    ).rejects.toMatchObject({ code: "RES_003" });
  });

  it("validates an active device session and rejects an expired one", async () => {
    const seedData = await seed();
    const future = new Date(Date.now() + 60_000);
    await db.insert(session).values({
      id: "sess-1",
      token: "session-token-1",
      userId: seedData.ownerId,
      expiresAt: future,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(validateDeviceSession("session-token-1")).resolves.toMatchObject({
      userId: seedData.ownerId,
      email: "owner@example.com",
    });

    await db.insert(session).values({
      id: "sess-2",
      token: "session-token-2",
      userId: seedData.ownerId,
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(validateDeviceSession("session-token-2")).rejects.toMatchObject({
      code: "AUTH_001",
    });
  });

  it("does not create a second resource for an unknown meta-user or a disabled scheme", async () => {
    const seedData = await seed();
    const resource = await sshResource(seedData);
    await setupSshTarget(resource.id, seedData.ownerId, {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
    await completeResourceValidation({
      resourceId: resource.id,
      clientId: "ssh-gateway",
      result: "validated",
      evidence: { hostKeyFingerprint: HOST_KEY },
    });
    await createSshMetaUser(resource.id, seedData.ownerId, "team-b");
    await expect(resolveSshTargetByMetaUser("unknown")).rejects.toMatchObject({
      code: "RES_004",
    });
    const [stored] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, resource.id));
    expect(stored?.uri).toMatch(/^ssh:\/\/[0-9a-f-]{36}$/);
  });
});
