import { and, asc, eq, ne, or } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import {
  applicationSchemes,
  resources,
  resourceSchemes,
} from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import {
  assertApplicationSchemeName,
  BUILTIN_SCHEME_NAMES,
  builtinSchemeRows,
  supportedPermissions,
} from "./schemes.js";
import type {
  ResourceAdapter,
  ResourcePermission,
  ResourceSchemeSource,
} from "./types.js";

export interface ResourceSchemeView {
  scheme: string;
  source: ResourceSchemeSource;
  adapter: ResourceAdapter;
  displayName: string;
  description: string | null;
  icon: string | null;
  validatorUrl: string | null;
  enabled: boolean;
  // The levels a grant on a resource of this scheme may carry.
  permissions: readonly ResourcePermission[];
}

export interface ApplicationSchemeView extends ResourceSchemeView {
  owned: boolean;
}

/** Seed or refresh the code-defined built-in schemes. */
export async function syncBuiltinSchemes(exec: DbExecutor = db): Promise<void> {
  const unknown = config.resources.enabledSchemes.filter(
    (scheme) => !BUILTIN_SCHEME_NAMES.has(scheme),
  );
  if (unknown.length > 0) {
    throw new Error(
      `RESOURCE_SCHEMES_ENABLED contains unknown built-in schemes: ${unknown.join(
        ", ",
      )}`,
    );
  }
  for (const row of builtinSchemeRows(config.resources.enabledSchemes)) {
    await exec
      .insert(resourceSchemes)
      .values(row)
      .onConflictDoUpdate({
        target: resourceSchemes.scheme,
        set: {
          adapter: row.adapter,
          displayName: row.displayName,
          description: row.description,
          icon: row.icon,
          status: row.status,
          validatorClientId: row.validatorClientId,
          updatedAt: new Date(),
        },
      });
  }
}

export async function getResourceScheme(
  scheme: string,
): Promise<ResourceSchemeView | null> {
  const [row] = await db
    .select({
      scheme: resourceSchemes.scheme,
      source: resourceSchemes.source,
      adapter: resourceSchemes.adapter,
      displayName: resourceSchemes.displayName,
      description: resourceSchemes.description,
      icon: resourceSchemes.icon,
      validatorUrl: resourceSchemes.validatorUrl,
      status: resourceSchemes.status,
    })
    .from(resourceSchemes)
    .where(eq(resourceSchemes.scheme, scheme))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    enabled: row.status === "active",
    permissions: supportedPermissions(row.scheme),
  };
}

/**
 * Schemes an application admin may enable: active built-ins and the
 * application's own schemes, with their current activation state.
 */
export async function listApplicationSchemeCatalog(
  applicationId: string,
): Promise<ApplicationSchemeView[]> {
  const rows = await db
    .select({
      scheme: resourceSchemes.scheme,
      source: resourceSchemes.source,
      adapter: resourceSchemes.adapter,
      displayName: resourceSchemes.displayName,
      description: resourceSchemes.description,
      icon: resourceSchemes.icon,
      validatorUrl: resourceSchemes.validatorUrl,
      enabled: applicationSchemes.enabled,
      ownerType: resourceSchemes.ownerType,
      ownerId: resourceSchemes.ownerId,
    })
    .from(resourceSchemes)
    .leftJoin(
      applicationSchemes,
      and(
        eq(applicationSchemes.scheme, resourceSchemes.scheme),
        eq(applicationSchemes.applicationId, applicationId),
      ),
    )
    .where(
      or(
        and(
          eq(resourceSchemes.source, "builtin"),
          eq(resourceSchemes.status, "active"),
        ),
        and(
          eq(resourceSchemes.source, "application"),
          eq(resourceSchemes.ownerType, "application"),
          eq(resourceSchemes.ownerId, applicationId),
          eq(resourceSchemes.status, "active"),
        ),
      ),
    )
    .orderBy(asc(resourceSchemes.displayName));

  return rows.map((row) => ({
    scheme: row.scheme,
    source: row.source,
    adapter: row.adapter,
    displayName: row.displayName,
    description: row.description,
    icon: row.icon,
    validatorUrl: row.validatorUrl,
    enabled: row.enabled === true,
    permissions: supportedPermissions(row.scheme),
    owned: row.ownerType === "application" && row.ownerId === applicationId,
  }));
}

export async function isSchemeEnabledForApplication(
  applicationId: string,
  scheme: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ scheme: resourceSchemes.scheme })
    .from(applicationSchemes)
    .innerJoin(
      applications,
      eq(applicationSchemes.applicationId, applications.id),
    )
    .innerJoin(
      resourceSchemes,
      eq(applicationSchemes.scheme, resourceSchemes.scheme),
    )
    .where(
      and(
        eq(applicationSchemes.applicationId, applicationId),
        eq(applicationSchemes.scheme, scheme),
        eq(applicationSchemes.enabled, true),
        eq(resourceSchemes.status, "active"),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function assertSchemeEnabledForApplication(
  applicationId: string,
  scheme: string,
  exec: DbExecutor = db,
): Promise<void> {
  if (await isSchemeEnabledForApplication(applicationId, scheme, exec)) return;
  throw ERR.RES_001("Resource scheme is not enabled for this application");
}

export async function enableSchemeForApplication(
  applicationId: string,
  scheme: string,
): Promise<void> {
  const [definition] = await db
    .select({
      source: resourceSchemes.source,
      status: resourceSchemes.status,
      ownerType: resourceSchemes.ownerType,
      ownerId: resourceSchemes.ownerId,
    })
    .from(resourceSchemes)
    .where(eq(resourceSchemes.scheme, scheme))
    .limit(1);
  if (!definition || definition.status !== "active") {
    throw ERR.RES_001("Resource scheme is not available");
  }
  if (
    definition.source === "application" &&
    !(
      definition.ownerType === "application" &&
      definition.ownerId === applicationId
    )
  ) {
    throw ERR.RES_004();
  }
  await db
    .insert(applicationSchemes)
    .values({ applicationId, scheme, enabled: true })
    .onConflictDoUpdate({
      target: [applicationSchemes.applicationId, applicationSchemes.scheme],
      set: { enabled: true },
    });
}

export async function disableSchemeForApplication(
  applicationId: string,
  scheme: string,
): Promise<void> {
  const [row] = await db
    .update(applicationSchemes)
    .set({ enabled: false })
    .where(
      and(
        eq(applicationSchemes.applicationId, applicationId),
        eq(applicationSchemes.scheme, scheme),
      ),
    )
    .returning({ scheme: applicationSchemes.scheme });
  if (!row) throw ERR.RES_004();
}

export interface CreateApplicationSchemeInput {
  applicationId: string;
  scheme: string;
  displayName: string;
  description?: string | null;
  icon?: string | null;
  validatorUrl?: string | null;
}

/** Register a new application-owned scheme and enable it for that app. */
export async function createApplicationScheme(
  input: CreateApplicationSchemeInput,
): Promise<ResourceSchemeView> {
  const scheme = assertApplicationSchemeName(input.scheme);
  const [app] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      enabled: applications.resourceSharingEnabled,
      isActive: applications.isActive,
      isPublic: applications.isPublic,
    })
    .from(applications)
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (!app || !app.enabled || !app.isActive) throw ERR.RES_004();
  // A public client cannot obtain the client-credentials token the validation
  // endpoint requires, so its resources could never be validated.
  if (app.isPublic) {
    throw ERR.RES_001("Public applications cannot own a resource scheme");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(resourceSchemes)
      .values({
        scheme,
        source: "application",
        adapter: "external",
        ownerType: "application",
        ownerId: input.applicationId,
        displayName: input.displayName,
        description: input.description ?? null,
        icon: input.icon ?? null,
        status: "active",
        validatorClientId: app.slug,
        validatorUrl: input.validatorUrl ?? null,
        config: {},
      })
      .onConflictDoNothing({ target: resourceSchemes.scheme })
      .returning();
    if (!row) throw ERR.RES_003("Resource scheme already exists");

    await tx
      .insert(applicationSchemes)
      .values({ applicationId: input.applicationId, scheme, enabled: true })
      .onConflictDoUpdate({
        target: [applicationSchemes.applicationId, applicationSchemes.scheme],
        set: { enabled: true },
      });

    return {
      scheme: row.scheme,
      source: row.source,
      adapter: row.adapter,
      displayName: row.displayName,
      description: row.description,
      icon: row.icon,
      validatorUrl: row.validatorUrl,
      enabled: true,
      permissions: supportedPermissions(row.scheme),
    };
  });
}

/**
 * Remove an application-owned scheme. Refused while a live resource uses it.
 * Resources that were all disabled keep their audit trail, so the scheme is
 * retired instead of dropped (the foreign key is RESTRICT).
 */
export async function deleteApplicationScheme(
  applicationId: string,
  scheme: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The row lock serialises with resource inserts, which take a key-share
    // lock on the scheme through their foreign key.
    const [owned] = await tx
      .select({ scheme: resourceSchemes.scheme })
      .from(resourceSchemes)
      .where(
        and(
          eq(resourceSchemes.scheme, scheme),
          eq(resourceSchemes.source, "application"),
          eq(resourceSchemes.ownerType, "application"),
          eq(resourceSchemes.ownerId, applicationId),
          eq(resourceSchemes.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!owned) throw ERR.RES_004();

    const [live] = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(eq(resources.scheme, scheme), ne(resources.status, "disabled")),
      )
      .limit(1);
    if (live) throw ERR.RES_013();

    const [any] = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(eq(resources.scheme, scheme))
      .limit(1);
    if (any) {
      await tx
        .update(resourceSchemes)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(eq(resourceSchemes.scheme, scheme));
    } else {
      await tx
        .delete(resourceSchemes)
        .where(eq(resourceSchemes.scheme, scheme));
    }
  });
}

/** Update display metadata of an application-owned scheme. */
export async function updateApplicationScheme(
  applicationId: string,
  scheme: string,
  patch: {
    displayName?: string;
    description?: string | null;
    icon?: string | null;
    validatorUrl?: string | null;
  },
): Promise<ResourceSchemeView> {
  const [row] = await db
    .update(resourceSchemes)
    .set({
      displayName: patch.displayName,
      description: patch.description,
      icon: patch.icon,
      validatorUrl: patch.validatorUrl,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resourceSchemes.scheme, scheme),
        eq(resourceSchemes.source, "application"),
        eq(resourceSchemes.ownerType, "application"),
        eq(resourceSchemes.ownerId, applicationId),
      ),
    )
    .returning();
  if (!row) throw ERR.RES_004();
  return {
    scheme: row.scheme,
    source: row.source,
    adapter: row.adapter,
    displayName: row.displayName,
    description: row.description,
    icon: row.icon,
    validatorUrl: row.validatorUrl,
    enabled: row.status === "active",
    permissions: supportedPermissions(row.scheme),
  };
}

/** The callback may only be made by the client bound to the scheme. */
export async function assertSchemeValidator(
  scheme: string,
  clientId: string,
): Promise<void> {
  const [row] = await db
    .select({ validatorClientId: resourceSchemes.validatorClientId })
    .from(resourceSchemes)
    .where(eq(resourceSchemes.scheme, scheme))
    .limit(1);
  if (!row || row.validatorClientId !== clientId) {
    throw ERR.AUTH_011("Client is not the validator for this resource scheme");
  }
}
