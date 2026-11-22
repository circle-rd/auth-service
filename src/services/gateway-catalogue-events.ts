import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { appRoom, publishEvent } from "./event-bus.js";

/**
 * Tell the open model pickers that the catalogue changed. The rooms are the
 * applications that share resources: only their members can be listing models.
 */
export async function announceCatalogueChanged(): Promise<void> {
  const apps = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    );
  const [first, ...rest] = apps.map((app) => appRoom(app.id));
  if (!first) return;
  publishEvent("catalogue.changed", [first, ...rest]);
}
