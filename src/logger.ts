import pino from "pino";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Pretty-print transport for local development only, and only when
 * `pino-pretty` is actually installed. The production image is built without
 * devDependencies, so a stray `NODE_ENV=development` must degrade to plain
 * JSON logs instead of crashing the process at startup.
 */
export function prettyTransport():
  { target: string; options: { colorize: boolean } } | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  try {
    require.resolve("pino-pretty");
    return { target: "pino-pretty", options: { colorize: true } };
  } catch {
    return undefined;
  }
}

/**
 * Application logger for modules that do not receive a Fastify instance
 * (bootstrap, mail transports, BetterAuth callbacks). Route and service code
 * that has a request/fastify handle should keep using `fastify.log`.
 *
 * Query strings are stripped because they can carry password-reset,
 * email-verification and magic-link tokens.
 */
const isDev = process.env.NODE_ENV === "development";

export const logger = pino({
  // `||` (not `??`): Compose passes unset variables as empty strings.
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: prettyTransport(),
  serializers: {
    req(req: { method?: string; url?: string }) {
      return {
        method: req.method,
        url: (req.url ?? "").split("?")[0],
      };
    },
  },
});
