import { describe, it, expect, vi } from "vitest";

// Minimal valid-ish base64 payload; the resolver never decodes the image.
const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function loadLogoModule(url: string | null) {
  vi.resetModules();
  const configMod = await import("../../config.js");
  (configMod.config as unknown as { appLogoUrl: string | null }).appLogoUrl =
    url;
  return await import("./logo.js");
}

describe("logo resolver", () => {
  it("returns null when APP_LOGO_URL is unset", async () => {
    const mod = await loadLogoModule(null);
    expect(mod.getCachedLogoAttachment()).toBeNull();
    expect(await mod.ensureLogoAttachmentWarmed()).toBeNull();
  });

  it("resolves and caches a data URI", async () => {
    const mod = await loadLogoModule(PNG_DATA_URI);
    expect(mod.getCachedLogoAttachment()).toBeNull();

    const attachment = await mod.ensureLogoAttachmentWarmed();
    expect(attachment?.cid).toBe("app-logo");
    expect(attachment?.contentType).toBe("image/png");
    expect(attachment?.content.byteLength).toBeGreaterThan(0);

    // Subsequent (synchronous) reads come from the cache.
    expect(mod.getCachedLogoAttachment()).toBe(attachment);
  });

  it("rejects an oversized data URI", async () => {
    const oversized = "data:image/png;base64," + "A".repeat(700_000);
    const mod = await loadLogoModule(oversized);
    expect(await mod.ensureLogoAttachmentWarmed()).toBeNull();
  });

  it("rejects loopback destinations (SSRF guard)", async () => {
    const mod = await loadLogoModule("http://127.0.0.1:9/logo.png");
    expect(await mod.ensureLogoAttachmentWarmed()).toBeNull();
  });
});
