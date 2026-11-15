import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import * as resourceSchema from "./resource-schema.js";
import * as gatewaySchema from "./gateway-schema.js";
import * as sshSchema from "./ssh-schema.js";
import { config } from "../config.js";

const queryClient = postgres(config.db.url);
export const db = drizzle(queryClient, {
  schema: { ...schema, ...resourceSchema, ...gatewaySchema, ...sshSchema },
  logger: config.logSql,
});
export type DB = typeof db;
