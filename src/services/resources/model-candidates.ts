import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { listGatewayModels, type GatewayModel } from "../gateway-inventory.js";
import { getUserIdentity, type UserIdentity } from "../usernames.js";
import { isApplicationAdmin } from "./authority.js";
import { assertLocator } from "./uri.js";

export const MODEL_CANDIDATE_SOURCES = ["managed", "native"] as const;
export type ModelCandidateSource = (typeof MODEL_CANDIDATE_SOURCES)[number];

const MANAGED_BY = "reverse-relay";

export interface ModelSupports {
  functionCalling: boolean;
  vision: boolean;
  videoInput: boolean;
  audioInput: boolean;
  audioOutput: boolean;
}

export interface ModelCandidate {
  name: string;
  locator: string;
  source: ModelCandidateSource;
  owned: boolean;
  createdBy: string | null;
  clientId: string | null;
  tags: string[];
  mode: string | null;
  supports: ModelSupports;
}

function textField(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function supportsOf(metadata: Record<string, unknown>): ModelSupports {
  const value = metadata.supports;
  const supports =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const enabled = (key: string) => supports[key] === true;
  return {
    functionCalling: enabled("functionCalling"),
    vision: enabled("vision"),
    videoInput: enabled("videoInput"),
    audioInput: enabled("audioInput"),
    audioOutput: enabled("audioOutput"),
  };
}

function matchesIdentity(
  value: string | null,
  identity: UserIdentity,
): boolean {
  if (!value) return false;
  const candidate = value.trim().toLowerCase();
  if (candidate === identity.id.toLowerCase()) return true;
  if (candidate === identity.email.toLowerCase()) return true;
  return identity.username?.toLowerCase() === candidate;
}

function sourceOf(model: GatewayModel): ModelCandidateSource {
  return textField(model.metadata, "managedBy") === MANAGED_BY
    ? "managed"
    : "native";
}

function ownedByUser(
  source: ModelCandidateSource,
  metadata: Record<string, unknown>,
  identity: UserIdentity,
): boolean {
  const createdBy = textField(metadata, "createdBy");
  if (matchesIdentity(createdBy, identity)) return true;
  if (source === "managed") {
    return matchesIdentity(textField(metadata, "clientId"), identity);
  }
  return false;
}

function candidateOf(
  model: GatewayModel,
  appSlug: string,
  identity: UserIdentity | null,
): ModelCandidate | null {
  const source = sourceOf(model);
  const locator = `${appSlug}/${model.name}`;
  try {
    assertLocator("llm", locator);
  } catch {
    return null;
  }
  const owned = identity
    ? ownedByUser(source, model.metadata, identity)
    : false;
  return {
    name: model.name,
    locator,
    source,
    owned,
    createdBy: textField(model.metadata, "createdBy"),
    clientId: textField(model.metadata, "clientId"),
    tags: stringList(model.metadata, "tags").sort(),
    mode: textField(model.metadata, "mode"),
    supports: supportsOf(model.metadata),
  };
}

/**
 * Models an application member may select when declaring an LLM resource.
 *
 * Application administrators see every model; other members only see the
 * models whose gateway owner is their own account. A native model with no
 * recorded owner is therefore visible to administrators only.
 */
export async function listModelCandidates(input: {
  appId: string;
  userId: string;
  source: ModelCandidateSource;
}): Promise<ModelCandidate[]> {
  const [app] = await db
    .select({
      slug: applications.slug,
      resourceSharingEnabled: applications.resourceSharingEnabled,
      isActive: applications.isActive,
    })
    .from(applications)
    .where(eq(applications.id, input.appId))
    .limit(1);
  if (!app || !app.resourceSharingEnabled || !app.isActive) {
    throw ERR.RES_004();
  }

  const admin = await isApplicationAdmin(input.userId, input.appId);
  const identity = admin ? null : await getUserIdentity(input.userId);
  const models = await listGatewayModels();

  return models
    .map((model) => candidateOf(model, app.slug, identity))
    .filter((model): model is ModelCandidate => model !== null)
    .filter((model) => model.source === input.source)
    .filter((model) => admin || model.owned)
    .sort((left, right) => left.name.localeCompare(right.name));
}
