import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { resourceGrants } from "../../db/resource-schema.js";
import {
  appManagerRoom,
  appRoom,
  orgRoom,
  publishEvent,
  userRoom,
  type Room,
  type RoomList,
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

/** Application ids by slug, for the `application` grants among the subjects. */
async function applicationIdsBySlug(
  subjects: readonly GrantSubjectRef[],
): Promise<Map<string, string>> {
  const slugs = subjects
    .filter((subject) => subject.subjectType === "application")
    .map((subject) => subject.subjectId)
    .filter((slug): slug is string => slug !== null);
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ id: applications.id, slug: applications.slug })
    .from(applications)
    .where(inArray(applications.slug, slugs));
  return new Map(rows.map((row) => [row.slug, row.id]));
}

/**
 * Rooms that may see a resource: its owner, every grantee, the application for
 * `plan` / `everyone` grants (enrolled users of the application only) and the
 * application an `application` grant opens the resource to.
 */
function resourceRooms(
  resource: ResourceRef,
  subjects: readonly GrantSubjectRef[],
  applicationIds: ReadonlyMap<string, string>,
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
      case "application": {
        if (!subject.subjectId) {
          throw new Error("application grant without subject");
        }
        // A deleted application has no one left to notify.
        const applicationId = applicationIds.get(subject.subjectId);
        if (applicationId) rooms.add(appRoom(applicationId));
        break;
      }
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
  publishEvent(
    "resource.changed",
    resourceRooms(resource, list, await applicationIdsBySlug(list)),
  );
}

/** The ownership fields of a usage row or access event, possibly unknown. */
export interface ActivityResourceRef {
  ownerType: string | null;
  ownerId: string | null;
  applicationId: string | null;
}

/**
 * Announce committed activity on a resource. The frame is a signal only; the
 * subscriber re-reads its own aggregate, which never contains another user's
 * identity. App managers hear about every resource in their application so
 * their management view stays current; ordinary members and grantees do not
 * have the `appmgr:` room.
 */
export function announceResourceActivity(
  resource: ActivityResourceRef,
  subjectId: string | null,
  options: { includeSubject?: boolean } = {},
): void {
  const includeSubject = options.includeSubject ?? true;
  const rooms = new Set<Room>();
  if (resource.ownerType === "user" && resource.ownerId) {
    rooms.add(userRoom(resource.ownerId));
  }
  if (resource.applicationId) {
    rooms.add(appManagerRoom(resource.applicationId));
  }
  if (includeSubject && subjectId) {
    rooms.add(userRoom(subjectId));
  }
  const [first, ...rest] = rooms;
  if (!first) return;
  publishEvent("resource.activity", [first, ...rest] as RoomList);
}
