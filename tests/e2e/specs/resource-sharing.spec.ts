import { test, expect, type Page } from "@playwright/test";

const AUTH_URL = "http://localhost:3001";
const DANA = { email: "dana@test.local", password: "TestPass1!" };

async function signInToPortal(page: Page): Promise<void> {
  await page.goto(`${AUTH_URL}/auth`);
  await page.fill('input[type="email"]', DANA.email);
  await page.fill('input[type="password"]', DANA.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${AUTH_URL}/profile`);
}

test.describe("Resource-sharing catalogue (AC-01 portal chain)", () => {
  test("one session sees two owners' resources and selects a model", async ({ page }) => {
    await signInToPortal(page);

    await page.goto(`${AUTH_URL}/share/catalogue`);
    await expect(page.getByTestId("subject-catalogue")).toBeVisible();

    const items = page.getByTestId("catalogue-item");
    await expect(items).toHaveCount(2);

    const modelA = items.filter({ hasText: "Shared Model A" });
    const modelB = items.filter({ hasText: "Shared Model B" });
    await expect(modelA).toHaveCount(1);
    await expect(modelB).toHaveCount(1);
    await expect(modelA).toContainText("test-app");
    await expect(modelB).toContainText("restricted-app");

    // Both seeded grants are unrestricted, so the client dimension is absent.
    await expect(page.getByText("Restricted clients")).toHaveCount(0);

    await expect(page.getByTestId("selected-model")).toContainText("Shared Model A");
    const selector = page.getByTestId("model-selector").getByRole("combobox");
    await selector.click();
    await page.getByRole("option", { name: /Shared Model B/ }).click();
    await expect(page.getByTestId("selected-model")).toContainText("Shared Model B");
  });
});
