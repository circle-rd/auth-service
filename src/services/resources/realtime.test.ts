import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, publishEvent } = vi.hoisted(() => ({
  state: { grants: [] as { subjectType: string; subjectId: string | null }[] },
  publishEvent: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(state.grants),
      }),
    }),
  },
}));

vi.mock("../event-bus.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishEvent,
}));

import { announceResourceChanged } from "./realtime.js";

const userResource = {
  id: "res-1",
  ownerType: "user",
  ownerId: "owner-1",
  applicationId: "app-1",
};

beforeEach(() => {
  state.grants = [];
  publishEvent.mockReset();
});

describe("announceResourceChanged", () => {
  it("addresses a private resource to its owner only", async () => {
    await announceResourceChanged(userResource, []);
    expect(publishEvent).toHaveBeenCalledWith("resource.changed", [
      "user:owner-1",
    ]);
  });

  it("addresses a user grant to that user and an organization grant to its members", async () => {
    await announceResourceChanged(userResource, [
      { subjectType: "user", subjectId: "bob" },
      { subjectType: "organization", subjectId: "org-9" },
    ]);
    expect(publishEvent).toHaveBeenCalledWith("resource.changed", [
      "user:owner-1",
      "user:bob",
      "org:org-9",
    ]);
  });

  it("addresses plan and everyone grants to the enrolled users of the application", async () => {
    await announceResourceChanged(userResource, [
      { subjectType: "plan", subjectId: "plan-1" },
      { subjectType: "everyone", subjectId: null },
    ]);
    expect(publishEvent).toHaveBeenCalledWith("resource.changed", [
      "user:owner-1",
      "app:app-1",
    ]);
  });

  it("addresses an application-owned resource to its application room", async () => {
    await announceResourceChanged(
      {
        id: "res-2",
        ownerType: "application",
        ownerId: "app-1",
        applicationId: "app-1",
      },
      [],
    );
    expect(publishEvent).toHaveBeenCalledWith("resource.changed", [
      "app:app-1",
    ]);
  });

  it("reads the active grants when none are passed", async () => {
    state.grants = [{ subjectType: "user", subjectId: "carol" }];
    await announceResourceChanged(userResource);
    expect(publishEvent).toHaveBeenCalledWith("resource.changed", [
      "user:owner-1",
      "user:carol",
    ]);
  });

  it("refuses a user grant without a subject rather than widening the audience", async () => {
    await expect(
      announceResourceChanged(userResource, [
        { subjectType: "user", subjectId: null },
      ]),
    ).rejects.toThrow("user grant without subject");
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
