import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { resourceGrants } from "../../db/resource-schema.js";
import {
  appRoom,
  orgRoom,
  publishEvent,
  userRoom,
  type Room,
} from "../event-bus.js";

/** The fields of a resource that decide who hears about its changes. */
export interface ResourceRef {
  id: string;
  ownerType: string;
  ownerId: string;
  applicationId: string;
}

/** The subject of a grant, as far as routing is concerned. */
export interface GrantSubjectRef {
  subjectType: string;
  subjectId: string | null;
}

/** Subjects holding an active (not revoked) grant on a resource. */
export async function activeGrantSubjects(
  resourceId: string,
): Promise<GrantSubjectRef[]> {
  return db
    .select({
      subjectType: resourceGrants.subjectType,
      subjectId: resourceGrants.subjectId,
    })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceId, resourceId),
        isNull(resourceGrants.revokedAt),
      ),
    );
}

/**
 * Rooms that may see a resource: its owner, every grantee, and the application
 * for `plan` / `everyone` grants (enrolled users of the application only).
 */
function resourceRooms(
  resource: ResourceRef,
  subjects: readonly GrantSubjectRef[],
): [Room, ...Room[]] {
  const rooms = new Set<Room>([
    resource.ownerType === "user"
      ? userRoom(resource.ownerId)
      : appRoom(resource.ownerId),
  ]);
  for (const subject of subjects) {
    switch (subject.subjectType) {
      case "user":
        if (!subject.subjectId) throw new Error("user grant without subject");
        rooms.add(userRoom(subject.subjectId));
        break;
      case "organization":
        if (!subject.subjectId) throw new Error("org grant without subject");
        rooms.add(orgRoom(subject.subjectId));
        break;
      case "plan":
      case "everyone":
        rooms.add(appRoom(resource.applicationId));
        break;
      default:
        throw new Error(`unknown grant subject type: ${subject.subjectType}`);
    }
  }
  const [first, ...rest] = rooms;
  return [first!, ...rest];
}

/**
 * Announce a committed change to a resource. Callers pass every subject whose
 * view changed: a revoked grant is no longer active, so it has to be named
 * explicitly. Without `subjects` the active grants are read.
 */
export async function announceResourceChanged(
  resource: ResourceRef,
  subjects?: readonly GrantSubjectRef[],
): Promise<void> {
  const list = subjects ?? (await activeGrantSubjects(resource.id));
  publishEvent("resource.changed", resourceRooms(resource, list));
}
