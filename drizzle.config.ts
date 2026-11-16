import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  out: "./drizzle",
  schema: [
    "./src/db/schema.ts",
    "./src/db/auth-schema.ts",
    "./src/db/resource-schema.ts",
    "./src/db/gateway-schema.ts",
    "./src/db/ssh-schema.ts",
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
