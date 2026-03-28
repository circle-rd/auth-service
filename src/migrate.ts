import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, "..", "drizzle");
  await migrate(db, { migrationsFolder });
}
