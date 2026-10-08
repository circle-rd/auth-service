import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DOMAIN_EVENT_TYPES,
  MemoryEventBus,
  createEventBus,
  getEventBus,
  publishEvent,
  setEventBus,
  type DomainEvent,
} from "./event-bus.js";

afterEach(() => {
  setEventBus(null);
  vi.restoreAllMocks();
});

describe("MemoryEventBus", () => {
  it("delivers a published event to every subscriber", () => {
    const bus = new MemoryEventBus();
    const seen: DomainEvent[][] = [[], []];
    bus.subscribe((e) => seen[0]!.push(e));
    bus.subscribe((e) => seen[1]!.push(e));

    bus.publish("login.recorded");

    for (const events of seen) {
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("login.recorded");
      expect(Number.isNaN(Date.parse(events[0]!.at))).toBe(false);
    }
  });

  it("carries nothing but the type and the timestamp", () => {
    const bus = new MemoryEventBus();
    let received: DomainEvent | null = null;
    bus.subscribe((e) => {
      received = e;
    });

    bus.publish("login.recorded");

    expect(Object.keys(received!).sort()).toEqual(["at", "type"]);
  });

  it("stops delivering to an unsubscribed subscriber", () => {
    const bus = new MemoryEventBus();
    const seen: DomainEvent[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e));

    bus.publish("login.recorded");
    unsubscribe();
    bus.publish("login.recorded");

    expect(seen).toHaveLength(1);
    expect(bus.subscriberCount).toBe(0);
  });

  it("keeps serving the other subscribers when one throws", () => {
    const bus = new MemoryEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe(() => {
      throw new Error("dead socket");
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.publish("login.recorded")).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("clears its subscribers on close", async () => {
    const bus = new MemoryEventBus();
    bus.subscribe(() => undefined);
    await bus.close();
    expect(bus.subscriberCount).toBe(0);
  });
});

describe("the application seam", () => {
  it("defaults to an in-process bus", () => {
    expect(getEventBus()).toBeInstanceOf(MemoryEventBus);
  });

  it("publishes through the installed bus", () => {
    const bus = new MemoryEventBus();
    setEventBus(bus);
    const seen: DomainEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    publishEvent("login.recorded");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("login.recorded");
  });

  it("never throws from publishEvent even if the bus does", () => {
    const bus = new MemoryEventBus();
    vi.spyOn(bus, "publish").mockImplementation(() => {
      throw new Error("bus down");
    });
    setEventBus(bus);

    // The publisher runs inside the login path: a broken bus must not fail it.
    expect(() => publishEvent("login.recorded")).not.toThrow();
  });
});

describe("createEventBus", () => {
  it("returns the in-memory bus when REDIS_URL is unset", async () => {
    const bus = await createEventBus();
    expect(bus).toBeInstanceOf(MemoryEventBus);
    expect(bus.name).toBe("memory");
    await bus.close();
  });
});

describe("the event vocabulary", () => {
  it("exposes the widened closed set, login.recorded first", () => {
    // The channel is a closed set on purpose: `RedisEventBus` validates remote
    // messages with `z.enum(DOMAIN_EVENT_TYPES)`, so a type that is emitted but
    // absent here would never survive the fan-out. `login.recorded` stays first
    // so this list reads as the original vocabulary plus the WP3 additions.
    expect([...DOMAIN_EVENT_TYPES]).toEqual([
      "login.recorded",
      "session.created",
      "session.revoked",
      "user.changed",
      "application.changed",
      "organization.changed",
    ]);
  });

  it("carries each type through the fan-out envelope unchanged", () => {
    // Whatever the type, the wire form is a type name and a timestamp — the
    // remote schema has no room for anything else.
    for (const type of DOMAIN_EVENT_TYPES) {
      const bus = new MemoryEventBus();
      const seen: DomainEvent[] = [];
      bus.subscribe((e) => seen.push(e));
      bus.publish(type);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.type).toBe(type);
      expect(Object.keys(seen[0]!).sort()).toEqual(["at", "type"]);
    }
  });
});
