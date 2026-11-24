import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, userApplications } from "../../db/schema.js";
import { member } from "../../db/auth-schema.js";
import {
  resourceGrants,
  resourceWebhookDeliveries,
} from "../../db/resource-schema.js";
import type { DbExecutor } from "../credential-user.js";
import type {
  ResourceOwnerType,
  ResourcePermission,
  ResourceStatus,
  ResourceSubjectType,
} from "./types.js";
import type { ResourceWebhookEvent } from "./webhooks.js";

const RECIPIENT_LIMIT = 500;

export interface WebhookResource {
  id: string;
  applicationId: string;
  uri: string;
  scheme: string;
  displayName: string;
  ownerType: ResourceOwnerType;
  ownerId: string;
  status: ResourceStatus;
}

export interface WebhookGrant {
  id: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  permission: ResourcePermission;
  previousPermission?: ResourcePermission;
  expiresAt?: Date | null;
}

interface Recipients {
  userIds: string[] | null;
  allMembers: boolean;
}

interface Receiver {
  id: string;
  slug: string;
  url: string;
  secret: string;
  isOwner: boolean;
}

interface ReceiverView {
  subjectId: string | null;
  recipients: Recipients;
}

async function isActiveApplicationMember(
  userId: string,
  applicationId: string,
  exec: DbExecutor,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, applicationId),
        eq(userApplications.isActive, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function organizationRecipients(
  organizationId: string,
  applicationId: string,
  exec: DbExecutor,
): Promise<Recipients> {
  const rows = await exec
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(
      userApplications,
      and(
        eq(userApplications.userId, member.userId),
        eq(userApplications.applicationId, applicationId),
        eq(userApplications.isActive, true),
      ),
    )
    .where(eq(member.organizationId, organizationId))
    .limit(RECIPIENT_LIMIT + 1);
  if (rows.length > RECIPIENT_LIMIT) return { userIds: null, allMembers: true };
  return { userIds: rows.map((row) => row.userId), allMembers: false };
}

/**
 * What one application may learn about a grant event. The owner application
 * hears everything. Another application hears only what concerns its own
 * members, so no identifier of a person or organization outside it is shared.
 */
async function viewForReceiver(
  receiver: Receiver,
  grant: WebhookGrant,
  exec: DbExecutor,
): Promise<ReceiverView | null> {
  if (receiver.isOwner) {
    if (grant.subjectType === "user") {
      return {
        subjectId: grant.subjectId,
        recipients: {
          userIds: grant.subjectId ? [grant.subjectId] : [],
          allMembers: false,
        },
      };
    }
    if (grant.subjectType === "organization" && grant.subjectId) {
      return {
        subjectId: grant.subjectId,
        recipients: await organizationRecipients(
          grant.subjectId,
          receiver.id,
          exec,
        ),
      };
    }
    // Everyone, plan and application grants can reach an unbounded audience:
    // the receiver treats that as a broadcast instead of receiving every id.
    return {
      subjectId: grant.subjectId,
      recipients: { userIds: null, allMembers: true },
    };
  }
  switch (grant.subjectType) {
    case "application":
      return grant.subjectId === receiver.slug
        ? {
            subjectId: grant.subjectId,
            recipients: { userIds: null, allMembers: true },
          }
        : null;
    case "everyone":
      return {
        subjectId: null,
        recipients: { userIds: null, allMembers: true },
      };
    case "user":
      return grant.subjectId &&
        (await isActiveApplicationMember(grant.subjectId, receiver.id, exec))
        ? {
            subjectId: grant.subjectId,
            recipients: { userIds: [grant.subjectId], allMembers: false },
          }
        : null;
    case "organization": {
      if (!grant.subjectId) return null;
      const recipients = await organizationRecipients(
        grant.subjectId,
        receiver.id,
        exec,
      );
      const empty =
        recipients.userIds !== null && recipients.userIds.length === 0;
      return empty ? null : { subjectId: null, recipients };
    }
    default:
      // Plans belong to the owner application.
      return null;
  }
}

/**
 * The applications that hear about a resource: its owner, every application
 * holding an active application grant, and the application an event names.
 */
async function loadReceivers(
  resource: WebhookResource,
  namedApplicationSlug: string | null,
  exec: DbExecutor,
): Promise<Receiver[]> {
  const now = new Date();
  const granted = await exec
    .select({ slug: resourceGrants.subjectId })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceId, resource.id),
        eq(resourceGrants.subjectType, "application"),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
      ),
    );
  const slugs = new Set(
    granted.map((row) => row.slug).filter((slug): slug is string => !!slug),
  );
  // A revoked grant is no longer active, but its application must still hear it.
  if (namedApplicationSlug) slugs.add(namedApplicationSlug);
  const rows = await exec
    .select({
      id: applications.id,
      slug: applications.slug,
      url: applications.resourceWebhookUrl,
      secret: applications.resourceWebhookSecret,
    })
    .from(applications)
    .where(
      slugs.size > 0
        ? or(
            eq(applications.id, resource.applicationId),
            inArray(applications.slug, [...slugs]),
          )
        : eq(applications.id, resource.applicationId),
    );
  const receivers: Receiver[] = [];
  for (const row of rows) {
    if (!row.url || !row.secret) continue;
    receivers.push({
      id: row.id,
      slug: row.slug,
      url: row.url,
      secret: row.secret,
      isOwner: row.id === resource.applicationId,
    });
  }
  return receivers;
}

export interface EnqueueResourceWebhookInput {
  type: ResourceWebhookEvent;
  resource: WebhookResource;
  grant: WebhookGrant;
}

export async function enqueueResourceWebhookEvent(
  input: EnqueueResourceWebhookInput,
  exec: DbExecutor = db,
): Promise<void> {
  const named =
    input.grant.subjectType === "application" ? input.grant.subjectId : null;
  for (const receiver of await loadReceivers(input.resource, named, exec)) {
    const view = await viewForReceiver(receiver, input.grant, exec);
    if (!view) continue;
    await insertDelivery(receiver, view, input, exec);
  }
}

async function insertDelivery(
  app: Receiver,
  view: ReceiverView,
  input: EnqueueResourceWebhookInput,
  exec: DbExecutor,
): Promise<void> {
  const eventId = randomUUID();
  const payload = {
    eventId,
    type: input.type,
    occurredAt: new Date().toISOString(),
    application: { id: app.id, slug: app.slug },
    resource: {
      id: input.resource.id,
      uri: input.resource.uri,
      scheme: input.resource.scheme,
      displayName: input.resource.displayName,
      ownerType: input.resource.ownerType,
      // The owner's identity stays inside the owner application.
      ...(app.isOwner ? { ownerId: input.resource.ownerId } : {}),
      status: input.resource.status,
    },
    grant: {
      id: input.grant.id,
      subjectType: input.grant.subjectType,
      subjectId: view.subjectId,
      permission: input.grant.permission,
      previousPermission: input.grant.previousPermission ?? null,
      expiresAt: input.grant.expiresAt?.toISOString() ?? null,
    },
    recipients: view.recipients,
  };

  await exec
    .insert(resourceWebhookDeliveries)
    .values({
      applicationId: app.id,
      eventId,
      eventType: input.type,
      payload,
    })
    .onConflictDoNothing({
      target: [
        resourceWebhookDeliveries.applicationId,
        resourceWebhookDeliveries.eventId,
      ],
    });
}

/**
 * Tell the owner application and every application holding an application
 * grant that a resource is gone. Call it before the delete, while the grants
 * can still be read. People holding user or organization grants belong to the
 * owner application, which hears the event, so nobody else needs it.
 */
export async function enqueueResourceDeletedEvent(
  resource: WebhookResource,
  exec: DbExecutor = db,
): Promise<void> {
  for (const receiver of await loadReceivers(resource, null, exec)) {
    const eventId = randomUUID();
    await exec
      .insert(resourceWebhookDeliveries)
      .values({
        applicationId: receiver.id,
        eventId,
        eventType: "resource.deleted",
        payload: {
          eventId,
          type: "resource.deleted",
          occurredAt: new Date().toISOString(),
          application: { id: receiver.id, slug: receiver.slug },
          resource: {
            id: resource.id,
            uri: resource.uri,
            scheme: resource.scheme,
            displayName: resource.displayName,
            ownerType: resource.ownerType,
            ...(receiver.isOwner ? { ownerId: resource.ownerId } : {}),
          },
        },
      })
      .onConflictDoNothing({
        target: [
          resourceWebhookDeliveries.applicationId,
          resourceWebhookDeliveries.eventId,
        ],
      });
  }
}
