import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { enableSchemeForApplication } from "./scheme-service.js";

/**
 * Owner application of the resources auto-declared from the gateway. It has no
 * OAuth client, no secret and no code: every resource must belong to an
 * application, and this one is the authorization boundary for relay models.
 */
export const CATALOGUE_SLUG = "catalogue";
const CATALOGUE_NAME = "Catalogue";
const CATALOGUE_SCHEMES = ["llm", "agent", "mcp"] as const;

export async function ensureCatalogueApplication(): Promise<void> {
  const [existing] = await db
    .select({ id: applications.id, isSystem: applications.isSystem })
    .from(applications)
    .where(eq(applications.slug, CATALOGUE_SLUG))
    .limit(1);
  if (existing && !existing.isSystem) {
    throw new Error(
      `[bootstrap] ${CATALOGUE_SLUG} is already an application but not a system one; ` +
        "rename or delete it before starting",
    );
  }
  const values = {
    name: CATALOGUE_NAME,
    description: "Owner of the resources declared from the LLM gateway",
    isActive: true,
    isSystem: true,
    skipConsent: true,
    allowRegister: false,
    isPublic: false,
    resourceSharingEnabled: true,
    allowedScopes: [],
    redirectUris: [],
  };
  const [app] = existing
    ? await db
        .update(applications)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(applications.id, existing.id))
        .returning({ id: applications.id })
    : await db
        .insert(applications)
        .values({ ...values, slug: CATALOGUE_SLUG })
        .returning({ id: applications.id });
  if (!app) throw new Error("[bootstrap] catalogue application not ensured");
  for (const scheme of CATALOGUE_SCHEMES) {
    if (config.resources.enabledSchemes.includes(scheme)) {
      await enableSchemeForApplication(app.id, scheme);
    }
  }
  logger.info("[res] catalogue application ensured");
}
