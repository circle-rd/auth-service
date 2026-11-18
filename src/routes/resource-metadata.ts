import { z } from "zod";

export const RESOURCE_METADATA_MAX_BYTES = 4096;

// Free-form owner data stored as jsonb: bounded so it cannot be used as storage.
export const resourceMetadataSchema = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= RESOURCE_METADATA_MAX_BYTES,
    { message: "Metadata is too large" },
  );
