import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sendEmail,
  setMailTransport,
  getMailTransport,
} from "./index.js";
import { MailCaptureTransport } from "./capture-transport.js";
import { NoopMailTransport } from "./noop-transport.js";

describe("mail pipeline", () => {
  let capture: MailCaptureTransport;

  beforeEach(() => {
    capture = new MailCaptureTransport();
    setMailTransport(capture);
  });

  afterEach(() => {
    setMailTransport(null);
  });

  it("renders the verify-email built-in template and ships it via the active transport", async () => {
    await sendEmail(
      "verify-email",
      "alice@example.com",
      { url: "https://auth.test/verify?token=abc", expiresInHours: 1 },
    );

    expect(capture.messages).toHaveLength(1);
    const msg = capture.messages[0]!;
    expect(msg.to).toBe("alice@example.com");
    expect(msg.subject).toMatch(/Verify your email/i);
    expect(msg.html).toContain("https://auth.test/verify?token=abc");
    expect(msg.text).toContain("https://auth.test/verify?token=abc");
  });

  it("auto-injects appName / authUrl context defaults", async () => {
    await sendEmail("reset-password", "bob@example.com", {
      url: "https://auth.test/reset?token=xyz",
      expiresInHours: 1,
    });

    const msg = capture.last("bob@example.com")!;
    // appName comes from APP_NAME env (default "CIRCLE Auth" in config.ts).
    expect(msg.subject).toMatch(/Reset your .* password/i);
    expect(msg.html).toContain("https://auth.test/reset?token=xyz");
  });

  it("propagates per-template frontmatter overrides (from / replyTo)", async () => {
    // Built-in templates do not set `from`, so msg.from is undefined and the
    // transport falls back to its configured default. Sanity-check this.
    await sendEmail("magic-link", "carol@example.com", {
      url: "https://auth.test/magic?t=1",
      expiresInMinutes: 5,
    });
    expect(capture.last()!.from).toBeUndefined();
  });

  it("re-throws transport failures so callers can surface them", async () => {
    class FailingTransport extends MailCaptureTransport {
      override async send(): Promise<void> {
        throw new Error("smtp down");
      }
    }
    setMailTransport(new FailingTransport());
    await expect(
      sendEmail("verify-email", "x@y", {
        url: "https://x",
        expiresInHours: 1,
      }),
    ).rejects.toThrow(/smtp down/);
  });

  it("getMailTransport() falls back to NoopMailTransport when SMTP_HOST is unset", () => {
    setMailTransport(null);
    const t = getMailTransport();
    expect(t).toBeInstanceOf(NoopMailTransport);
  });
});
