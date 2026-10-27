import { describe, expect, it } from "vitest";
import {
  INVITATION_FLOW_COOKIE,
  createInvitationFlowValue,
  parseInvitationFlowValue,
  readInvitationFlow,
  toInvitationFlow,
} from "./invitation-cookie.js";

describe("invitation flow cookie", () => {
  const flow = {
    kind: "organization" as const,
    invitationId: "invitation-123",
    email: "Invitee@Example.com",
  };

  it("round-trips a signed flow and normalises the address", () => {
    const value = createInvitationFlowValue(flow);
    const parsed = parseInvitationFlowValue(value);
    expect(parsed).toMatchObject({
      kind: "organization",
      invitationId: "invitation-123",
      email: "invitee@example.com",
    });
  });

  it("rejects a tampered payload", () => {
    const value = createInvitationFlowValue(flow);
    const [payload, signature] = value.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        kind: "organization",
        invitationId: "other",
        email: flow.email,
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString("base64url");
    expect(
      parseInvitationFlowValue(`${tamperedPayload}.${signature}`),
    ).toBeNull();
    expect(parseInvitationFlowValue(`${payload}.forged`)).toBeNull();
  });

  it("rejects an expired flow", () => {
    const value = createInvitationFlowValue(flow);
    const payload = JSON.parse(
      Buffer.from(value.split(".")[0]!, "base64url").toString("utf8"),
    ) as { exp: number };
    expect(
      parseInvitationFlowValue(value, new Date((payload.exp + 1) * 1000)),
    ).toBeNull();
  });

  it("reads the cookie from Headers and object-shaped headers", () => {
    const value = createInvitationFlowValue(flow);
    expect(
      readInvitationFlow(
        new Headers({ cookie: `other=1; ${INVITATION_FLOW_COOKIE}=${value}` }),
      ),
    ).not.toBeNull();
    expect(
      readInvitationFlow({ Cookie: `${INVITATION_FLOW_COOKIE}=${value}` }),
    ).not.toBeNull();
    expect(readInvitationFlow({ cookie: "other=1" })).toBeNull();
  });

  it("narrows server-trusted OAuth state into a flow", () => {
    expect(
      toInvitationFlow({
        kind: "application",
        invitationId: "inv-1",
        email: "User@Example.com",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toEqual({
      kind: "application",
      invitationId: "inv-1",
      email: "user@example.com",
      exp: expect.any(Number),
    });
    expect(toInvitationFlow({ kind: "organization" })).toBeNull();
    expect(toInvitationFlow("not-an-object")).toBeNull();
  });
});
