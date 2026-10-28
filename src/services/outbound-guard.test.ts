import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));

import { assertNonLocalHost, assertPublicHost } from "./outbound-guard.js";

const resolvesTo = (...addresses: string[]) =>
  lookup.mockResolvedValue(addresses.map((address) => ({ address })));

beforeEach(() => lookup.mockReset());

describe("assertPublicHost", () => {
  it.each([
    "10.0.0.5",
    "192.168.1.2",
    "172.16.0.1",
    "127.0.0.1",
    "::1",
    "fd00::1",
  ])("refuses the address %s", async (host) => {
    await expect(assertPublicHost(host)).rejects.toThrow("blocked");
  });

  it.each(["localhost", "app.localhost", "printer.local", "db.internal"])(
    "refuses the name %s",
    async (host) => {
      await expect(assertPublicHost(host)).rejects.toThrow("blocked host");
    },
  );

  it("refuses a name that resolves to a private address", async () => {
    resolvesTo("93.184.216.34", "10.1.2.3");
    await expect(assertPublicHost("split.example.com")).rejects.toThrow(
      "blocked address",
    );
  });

  it("accepts a name that resolves to public addresses only", async () => {
    resolvesTo("93.184.216.34");
    await expect(assertPublicHost("example.com")).resolves.toBeUndefined();
  });
});

describe("assertNonLocalHost", () => {
  it.each(["10.0.0.5", "192.168.1.2", "172.16.0.1", "100.64.0.1", "fd00::1"])(
    "allows the internal address %s",
    async (host) => {
      await expect(assertNonLocalHost(host)).resolves.toBeUndefined();
    },
  );

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "::ffff:127.0.0.1",
    "[::1]",
  ])("refuses the local address %s", async (host) => {
    await expect(assertNonLocalHost(host)).rejects.toThrow("blocked");
  });

  it.each(["localhost", "app.localhost"])(
    "refuses the name %s",
    async (host) => {
      await expect(assertNonLocalHost(host)).rejects.toThrow("blocked host");
    },
  );

  it("allows internal names, which an internal DNS may serve", async () => {
    resolvesTo("10.0.0.89");
    await expect(
      assertNonLocalHost("regine.circle-cyber.com"),
    ).resolves.toBeUndefined();
    await expect(assertNonLocalHost("api.internal")).resolves.toBeUndefined();
  });

  it("refuses a name that resolves to a loopback or link-local address", async () => {
    resolvesTo("93.184.216.34", "169.254.169.254");
    await expect(assertNonLocalHost("rebind.example.com")).rejects.toThrow(
      "blocked address",
    );
  });

  it("refuses a name that does not resolve", async () => {
    resolvesTo();
    await expect(assertNonLocalHost("nowhere.example.com")).rejects.toThrow(
      "unresolvable",
    );
  });
});
