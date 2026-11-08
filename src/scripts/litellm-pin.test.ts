import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const IMAGE_TAG = /ghcr\.io\/berriai\/litellm:(v\d+\.\d+\.\d+)/;

// Compose, the test script, the env sample and the guide each need a standalone
// default; this guard keeps them from drifting (they did: v1.105.0 vs v1.106.2).
function pin(path: string, marker: string): string | undefined {
  const content = readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
  const line = content.split("\n").find((entry) => entry.includes(marker));
  return line ? IMAGE_TAG.exec(line)?.[1] : undefined;
}

describe("LiteLLM image pin", () => {
  it("agrees in compose, package.json, .env.example and the gateway guide", () => {
    const pins = [
      pin("docker-compose.yml", "image: ${LITELLM_IMAGE"),
      pin("package.json", '"test:litellm"'),
      pin(".env.example", "# LITELLM_IMAGE="),
      pin(
        "docs-site/content/docs/3.guides/2.integration/4.litellm-gateway.md",
        "| `LITELLM_IMAGE` |",
      ),
    ];
    expect(pins[0]).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pins.every((value) => value === pins[0])).toBe(true);
  });
});
