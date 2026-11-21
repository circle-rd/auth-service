import { describe, it, expect, vi } from "vitest";
import {
  ADMIN_ROOM,
  appRoom,
  orgRoom,
  userRoom,
  type DomainEvent,
  type DomainEventType,
  type Room,
} from "./event-bus.js";
import { deliveryFor, type Audience } from "./realtime-audience.js";

vi.mock("../db/index.js", () => ({ db: {} }));

const NOTHING = { write: false, close: false };
const FRAME = { write: true, close: false };
const CLOSE = { write: false, close: true };
const FRAME_THEN_CLOSE = { write: true, close: true };

function audience(rooms: Room[], admin = false): Audience {
  return { rooms: new Set(rooms), admin };
}

function decide(type: DomainEventType, rooms: Room[], who: Audience) {
  const event: DomainEvent = {
    type,
    at: "2026-11-21T10:00:00.000Z",
    rooms: rooms as [Room, ...Room[]],
  };
  return deliveryFor(event, who);
}

describe("deliveryFor", () => {
  it("does nothing for an event addressed to no room of the connection", () => {
    expect(
      decide(
        "wallet.changed",
        [userRoom("bob")],
        audience([userRoom("alice")]),
      ),
    ).toEqual(NOTHING);
  });

  it("writes a user type to a matching user room", () => {
    expect(
      decide(
        "wallet.changed",
        [userRoom("alice")],
        audience([userRoom("alice")]),
      ),
    ).toEqual(FRAME);
  });

  it("never writes an administration type to a non-admin connection", () => {
    for (const type of [
      "login.recorded",
      "presence.changed",
      "application.changed",
    ] as const) {
      expect(
        decide(type, [userRoom("alice")], audience([userRoom("alice")])),
      ).toEqual(NOTHING);
    }
  });

  it("writes every type to an admin connection that matches the admin room", () => {
    expect(
      decide(
        "login.recorded",
        [ADMIN_ROOM],
        audience([ADMIN_ROOM, userRoom("a")], true),
      ),
    ).toEqual(FRAME);
  });

  it("writes catalogue events to an enrolled application room", () => {
    expect(
      decide(
        "catalogue.changed",
        [appRoom("app-1")],
        audience([userRoom("a"), appRoom("app-1")]),
      ),
    ).toEqual(FRAME);
  });

  it("closes the stream when a closing type reaches a non-admin room", () => {
    for (const type of [
      "session.revoked",
      "user.changed",
      "organization.changed",
    ] as const) {
      expect(
        decide(
          type,
          [ADMIN_ROOM, userRoom("alice")],
          audience([userRoom("alice")]),
        ),
      ).toEqual(CLOSE);
    }
  });

  it("gives an administrator the frame and then closes their own stream", () => {
    expect(
      decide(
        "user.changed",
        [ADMIN_ROOM, userRoom("a")],
        audience([ADMIN_ROOM, userRoom("a")], true),
      ),
    ).toEqual(FRAME_THEN_CLOSE);
  });

  it("only writes, and does not close, for an administrator's change to someone else", () => {
    expect(
      decide(
        "user.changed",
        [ADMIN_ROOM, userRoom("b")],
        audience([ADMIN_ROOM, userRoom("a")], true),
      ),
    ).toEqual(FRAME);
  });

  it("closes organization members on a membership change", () => {
    expect(
      decide(
        "organization.changed",
        [ADMIN_ROOM, orgRoom("o-1")],
        audience([userRoom("m"), orgRoom("o-1")]),
      ),
    ).toEqual(CLOSE);
  });
});
