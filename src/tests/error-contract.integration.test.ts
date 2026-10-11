import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

describe("error contract on the real server", () => {
  it("serialises an ApiError thrown by a route handler in the documented envelope", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/api/consumption",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: {
        code: "CONS_004",
        message: "Caller not authorized (requires client_credentials)",
      },
    });
  });

  it("keeps Fastify's own status for framework errors such as malformed JSON", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/api/consumption",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });
});
