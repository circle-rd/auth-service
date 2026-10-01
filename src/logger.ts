import pino from "pino";

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
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
  serializers: {
    req(req: { method?: string; url?: string }) {
      return {
        method: req.method,
        url: (req.url ?? "").split("?")[0],
      };
    },
  },
});
