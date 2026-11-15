import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { resourceUsageRecords, resources } from "../../db/resource-schema.js";
import {
  sshResourceDetails,
  sshResourceIdentities,
  sshShareDetails,
  sshSessions,
  type SshSessionEndReason,
} from "../../db/ssh-schema.js";
import { ERR } from "../../errors.js";
import { assertCanManageResource } from "../resources/authority.js";
import { getResource, type ResourceView } from "../resources/registry.js";
import { isSchemeEnabledForApplication } from "../resources/scheme-service.js";
import {
  authorizedKeysLine,
  encryptSshPrivateKey,
  generateSshIdentity,
} from "./crypto.js";

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const META_USER_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface SshTargetInput {
  host: string;
  port: number;
  account: string;
}

export interface SshOwnerDetail {
  resourceId: string;
  uri: string;
  host: string;
  port: number;
  account: string;
  publicKey: string;
  fingerprint: string;
  authorizedKeysLine: string;
  validationCommand: string | null;
  hostKeyFingerprint: string | null;
  validatedAt: Date | null;
}

export interface SshGatewayDetail {
  resourceId: string;
  uri: string;
  status: ResourceView["status"];
  applicationId: string;
  ownerType: ResourceView["ownerType"];
  ownerId: string;
  target: SshTargetInput;
  hostKeyFingerprint: string | null;
  identity: {
    publicKey: string;
    privateKeyCiphertext: string;
    keyVersion: number;
  };
}

export interface SshTargetLookup {
  resourceId: string;
  resourceUri: string;
  applicationId: string;
  applicationSlug: string;
}

function validateTarget(input: SshTargetInput): SshTargetInput {
  const host = input.host.trim();
  if (!HOST_RE.test(host) || host.includes("://")) {
    throw ERR.RES_001("Invalid SSH host");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw ERR.RES_001("Invalid SSH port");
  }
  const account = input.account.trim();
  if (!ACCOUNT_RE.test(account)) {
    throw ERR.RES_001("Invalid SSH account");
  }
  return { host, port: input.port, account };
}

async function assertSshResource(resourceId: string): Promise<ResourceView> {
  const resource = await getResource(resourceId);
  if (resource.scheme !== "ssh") throw ERR.RES_004();
  return resource;
}

async function ownerDetail(resourceId: string): Promise<SshOwnerDetail> {
  const resource = await assertSshResource(resourceId);
  const [detail] = await db
    .select()
    .from(sshResourceDetails)
    .where(eq(sshResourceDetails.resourceId, resourceId))
    .limit(1);
  const [identity] = await db
    .select()
    .from(sshResourceIdentities)
    .where(eq(sshResourceIdentities.resourceId, resourceId))
    .limit(1);
  if (!detail || !identity) {
    throw ERR.RES_001("SSH target is not configured yet");
  }
  const validationCommand = buildSshValidationCommand(resource.id);
  return {
    resourceId: resource.id,
    uri: resource.uri,
    host: detail.host,
    port: detail.port,
    account: detail.account,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    authorizedKeysLine: authorizedKeysLine(identity.publicKey, resource.id),
    validationCommand,
    hostKeyFingerprint: detail.hostKeyFingerprint,
    validatedAt: detail.validatedAt,
  };
}

export function buildSshValidationCommand(resourceId: string): string | null {
  const { validationHost, port } = config.sshGateway;
  if (!validationHost) return null;
  return `ssh -p ${port} validate-${resourceId}@${validationHost}`;
}

/**
 * Set or update the target and make sure the identity key exists. The owner
 * installs the returned line on the target before validating.
 */
export async function setupSshTarget(
  resourceId: string,
  actorUserId: string,
  input: SshTargetInput,
): Promise<SshOwnerDetail> {
  const resource = await assertSshResource(resourceId);
  await assertCanManageResource(actorUserId, resource);
  const target = validateTarget(input);
  // Fail before any write: authorized_keys cannot be generated without the
  // gateway egress address, and a committed target would leave a broken setup.
  if (!config.sshGateway.egressIp) {
    throw ERR.SRV_001(
      "SSH_GATEWAY_EGRESS_IP is not configured; SSH targets cannot be saved",
    );
  }

  await db.transaction(async (tx) => {
    const [existingDetail] = await tx
      .select()
      .from(sshResourceDetails)
      .where(eq(sshResourceDetails.resourceId, resourceId))
      .limit(1);
    const targetChanged =
      existingDetail !== undefined &&
      (existingDetail.host !== target.host ||
        existingDetail.port !== target.port ||
        existingDetail.account !== target.account);
    await tx
      .insert(sshResourceDetails)
      .values({
        resourceId,
        host: target.host,
        port: target.port,
        account: target.account,
      })
      .onConflictDoUpdate({
        target: sshResourceDetails.resourceId,
        set: {
          host: target.host,
          port: target.port,
          account: target.account,
          ...(targetChanged
            ? { hostKeyFingerprint: null, validatedAt: null }
            : {}),
          updatedAt: new Date(),
        },
      });
    if (targetChanged) {
      // The old host-key pin no longer describes this target: existing grants
      // must wait for a fresh validation.
      await tx
        .update(resources)
        .set({
          status: "pending_validation",
          validatedAt: null,
          validationError: null,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, resourceId));
    }
    const [identity] = await tx
      .select({ resourceId: sshResourceIdentities.resourceId })
      .from(sshResourceIdentities)
      .where(eq(sshResourceIdentities.resourceId, resourceId))
      .limit(1);
    if (!identity) {
      const generated = generateSshIdentity();
      await tx.insert(sshResourceIdentities).values({
        resourceId,
        publicKey: generated.publicKey,
        fingerprint: generated.fingerprint,
        privateKeyCiphertext: encryptSshPrivateKey(generated.privateKeyPem),
      });
    }
  });
  return ownerDetail(resourceId);
}

export async function getSshOwnerDetail(
  resourceId: string,
  actorUserId: string,
): Promise<SshOwnerDetail> {
  const resource = await assertSshResource(resourceId);
  await assertCanManageResource(actorUserId, resource);
  return ownerDetail(resourceId);
}

/**
 * Gateway-side detail. The optional subject is used by the validation flow to
 * prove that the device-approved user owns or manages the pending resource.
 */
export async function getSshGatewayDetail(
  resourceId: string,
  subjectId?: string,
): Promise<SshGatewayDetail> {
  const resource = await assertSshResource(resourceId);
  if (resource.status === "disabled") throw ERR.RES_004();
  if (subjectId) await assertCanManageResource(subjectId, resource);
  const [detail] = await db
    .select()
    .from(sshResourceDetails)
    .where(eq(sshResourceDetails.resourceId, resourceId))
    .limit(1);
  const [identity] = await db
    .select()
    .from(sshResourceIdentities)
    .where(eq(sshResourceIdentities.resourceId, resourceId))
    .limit(1);
  if (!detail || !identity) throw ERR.RES_004();
  return {
    resourceId: resource.id,
    uri: resource.uri,
    status: resource.status,
    applicationId: resource.applicationId,
    ownerType: resource.ownerType,
    ownerId: resource.ownerId,
    target: { host: detail.host, port: detail.port, account: detail.account },
    hostKeyFingerprint: detail.hostKeyFingerprint,
    identity: {
      publicKey: identity.publicKey,
      privateKeyCiphertext: identity.privateKeyCiphertext,
      keyVersion: identity.keyVersion,
    },
  };
}

export async function setSshHostKeyFingerprint(
  resourceId: string,
  fingerprint: string,
): Promise<void> {
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw ERR.RES_001("Invalid SSH host key fingerprint");
  }
  const [row] = await db
    .update(sshResourceDetails)
    .set({
      hostKeyFingerprint: fingerprint,
      validatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sshResourceDetails.resourceId, resourceId))
    .returning({ resourceId: sshResourceDetails.resourceId });
  if (!row) throw ERR.RES_001("SSH target is not configured");
}

export async function createSshMetaUser(
  resourceId: string,
  actorUserId: string,
  metaUser: string,
): Promise<{ id: string; metaUser: string }> {
  const resource = await assertSshResource(resourceId);
  await assertCanManageResource(actorUserId, resource);
  const normalized = metaUser.trim().toLowerCase();
  if (!META_USER_RE.test(normalized)) {
    throw ERR.RES_001("Invalid meta-user");
  }
  const [row] = await db
    .insert(sshShareDetails)
    .values({ resourceId, metaUser: normalized, createdBy: actorUserId })
    .onConflictDoNothing({ target: sshShareDetails.metaUser })
    .returning({ id: sshShareDetails.id, metaUser: sshShareDetails.metaUser });
  if (!row) throw ERR.RES_003("Meta-user already exists");
  return row;
}

export async function listSshMetaUsers(
  resourceId: string,
  actorUserId: string,
): Promise<Array<{ id: string; metaUser: string; createdAt: Date }>> {
  const resource = await assertSshResource(resourceId);
  await assertCanManageResource(actorUserId, resource);
  return db
    .select({
      id: sshShareDetails.id,
      metaUser: sshShareDetails.metaUser,
      createdAt: sshShareDetails.createdAt,
    })
    .from(sshShareDetails)
    .where(eq(sshShareDetails.resourceId, resourceId));
}

export async function deleteSshMetaUser(
  resourceId: string,
  actorUserId: string,
  metaUser: string,
): Promise<void> {
  const resource = await assertSshResource(resourceId);
  await assertCanManageResource(actorUserId, resource);
  const [row] = await db
    .delete(sshShareDetails)
    .where(
      and(
        eq(sshShareDetails.resourceId, resourceId),
        eq(sshShareDetails.metaUser, metaUser.toLowerCase()),
      ),
    )
    .returning({ id: sshShareDetails.id });
  if (!row) throw ERR.RES_004();
}

export async function resolveSshTargetByMetaUser(
  metaUser: string,
): Promise<SshTargetLookup> {
  const normalized = metaUser.trim().toLowerCase();
  if (!META_USER_RE.test(normalized)) throw ERR.RES_004();
  const [row] = await db
    .select({
      resourceId: resources.id,
      resourceUri: resources.uri,
      applicationId: resources.applicationId,
      applicationSlug: applications.slug,
      status: resources.status,
    })
    .from(sshShareDetails)
    .innerJoin(resources, eq(sshShareDetails.resourceId, resources.id))
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(eq(sshShareDetails.metaUser, normalized))
    .limit(1);
  if (!row || row.status !== "validated") throw ERR.RES_004();
  if (!(await isSchemeEnabledForApplication(row.applicationId, "ssh"))) {
    throw ERR.RES_004();
  }
  return {
    resourceId: row.resourceId,
    resourceUri: row.resourceUri,
    applicationId: row.applicationId,
    applicationSlug: row.applicationSlug,
  };
}

export interface SshSessionInput {
  resourceId: string;
  resourceUri: string;
  subjectId: string;
  clientId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  bytesIn: number | null;
  bytesOut: number | null;
  endReason: SshSessionEndReason;
}

export interface SshSessionResult {
  sessionId: string;
  replayed: boolean;
}

/**
 * Store the session and one gross usage row. The gateway is the trusted
 * producer; a replay is idempotent by `sessionId`.
 */
export async function recordSshSession(
  input: SshSessionInput,
): Promise<SshSessionResult> {
  const resource = await assertSshResource(input.resourceId);
  if (input.resourceUri !== resource.uri) {
    throw ERR.RES_001("Session resource URI does not match the resource");
  }
  if (input.endedAt.getTime() < input.startedAt.getTime()) {
    throw ERR.RES_001("Session end precedes its start");
  }
  const matches = (row: typeof sshSessions.$inferSelect): boolean =>
    row.resourceId === resource.id &&
    row.subjectId === input.subjectId &&
    row.clientId === input.clientId &&
    row.startedAt.getTime() === input.startedAt.getTime() &&
    row.endedAt.getTime() === input.endedAt.getTime() &&
    row.bytesIn === input.bytesIn &&
    row.bytesOut === input.bytesOut &&
    row.endReason === input.endReason;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(sshSessions)
      .where(eq(sshSessions.sessionId, input.sessionId))
      .limit(1);
    if (existing) {
      if (!matches(existing)) {
        throw ERR.RES_001(
          "This session id was already reported with different data",
        );
      }
      return { sessionId: input.sessionId, replayed: true };
    }

    const [session] = await tx
      .insert(sshSessions)
      .values({
        resourceId: resource.id,
        subjectId: input.subjectId,
        clientId: input.clientId,
        sessionId: input.sessionId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        bytesIn: input.bytesIn,
        bytesOut: input.bytesOut,
        endReason: input.endReason,
      })
      .onConflictDoNothing({ target: sshSessions.sessionId })
      .returning({ sessionId: sshSessions.sessionId });
    if (!session) {
      const [raced] = await tx
        .select()
        .from(sshSessions)
        .where(eq(sshSessions.sessionId, input.sessionId))
        .limit(1);
      if (!raced || !matches(raced)) {
        throw ERR.RES_001(
          "This session id was already reported with different data",
        );
      }
      return { sessionId: input.sessionId, replayed: true };
    }

    await tx
      .insert(resourceUsageRecords)
      .values({
        occurredAt: input.endedAt,
        resourceId: resource.id,
        uri: resource.uri,
        scheme: resource.scheme,
        ownerType: resource.ownerType,
        ownerId: resource.ownerId,
        subjectType: "user",
        subjectId: input.subjectId,
        clientId: input.clientId,
        applicationId: resource.applicationId,
        requestId: input.sessionId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        costUsd: "0",
        usageSource: "provider",
      })
      .onConflictDoNothing({
        target: [
          resourceUsageRecords.resourceId,
          resourceUsageRecords.requestId,
        ],
      });
    return { sessionId: input.sessionId, replayed: false };
  });
}
