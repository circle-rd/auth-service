import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { globalErrorHandler } from "./error-handler.js";
import { ERR } from "./errors.js";
import { config } from "./config.js";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function createReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      captured.status = code;
      return reply;
    },
    header(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      captured.body = payload;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, captured };
}

function createRequest(
  url: string,
  headers: Record<string, string> = {},
  query: Record<string, unknown> = {},
): FastifyRequest {
  return {
    url,
    headers,
    query,
    log: { error() {}, warn() {}, info() {}, debug() {} },
  } as unknown as FastifyRequest;
}

describe("globalErrorHandler content negotiation", () => {
  let dir: string;
  const mutable = config as unknown as { templatesDir: string | null };
  const originalDir = mutable.templatesDir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "error-handler-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    writeFileSync(
      join(dir, "default", "error.html"),
      "<%= it.ERROR_CODE %>|<%= it.ERROR_DESCRIPTION %>",
    );
    mutable.templatesDir = dir;
  });

  afterAll(() => {
    mutable.templatesDir = originalDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the templated page for a browser navigation", async () => {
    const { reply, captured } = createReply();
    await globalErrorHandler(
      ERR.APP_002(),
      createRequest("/some-page", { accept: "text/html" }),
      reply,
    );

    expect(captured.status).toBe(404);
    expect(captured.headers["content-type"]).toContain("text/html");
    expect(String(captured.body)).toContain("APP_002");
  });

  it("keeps the JSON envelope for API requests even when HTML is accepted", async () => {
    const { reply, captured } = createReply();
    await globalErrorHandler(
      ERR.APP_002(),
      createRequest("/api/thing", { accept: "text/html" }),
      reply,
    );

    expect(captured.headers["content-type"]).toBeUndefined();
    expect(captured.body).toEqual(ERR.APP_002().toJSON());
  });

  it("keeps the JSON envelope when the client does not accept HTML", async () => {
    const { reply, captured } = createReply();
    await globalErrorHandler(
      ERR.APP_002(),
      createRequest("/some-page", { accept: "application/json" }),
      reply,
    );

    expect(captured.body).toEqual(ERR.APP_002().toJSON());
  });

  it("falls back to JSON when no templates dir is configured", async () => {
    mutable.templatesDir = null;
    try {
      const { reply, captured } = createReply();
      await globalErrorHandler(
        ERR.APP_002(),
        createRequest("/some-page", { accept: "text/html" }),
        reply,
      );
      expect(captured.body).toEqual(ERR.APP_002().toJSON());
    } finally {
      mutable.templatesDir = dir;
    }
  });
});
