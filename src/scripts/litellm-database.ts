import postgres from "postgres";

const DATABASE_NAME = /^[a-z_][a-z0-9_]*$/;
const DUPLICATE_DATABASE = "42P04";

/**
 * Create the gateway's database when it is missing (LiteLLM keeps its own, next to
 * the auth one). `adminUrl` points at any database of the server, with a role that
 * may create databases. Idempotent, also on a postgres volume that predates it.
 */
export async function ensureDatabase(
  adminUrl: string,
  name: string,
): Promise<"created" | "exists"> {
  // The name goes into a statement that cannot be parameterized.
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`Invalid database name: ${name}`);
  }
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    const found = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length > 0) return "exists";
    try {
      await sql.unsafe(`CREATE DATABASE "${name}"`);
    } catch (err) {
      if ((err as { code?: string }).code === DUPLICATE_DATABASE) {
        return "exists";
      }
      throw err;
    }
    return "created";
  } finally {
    await sql.end();
  }
}
