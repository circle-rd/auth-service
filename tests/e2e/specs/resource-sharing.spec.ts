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

async function selectApplication(page: Page, name: string): Promise<void> {
  await page.locator("aside").getByRole("combobox").click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

test.describe("Resource-sharing catalogue (AC-01 portal chain)", () => {
  test("one session sees two owners' resources", async ({ page }) => {
    await signInToPortal(page);

    await page.goto(`${AUTH_URL}/catalogue`);
    await expect(page.getByTestId("subject-catalogue")).toBeVisible();
    await expect(page.getByTestId("catalogue-dashboard")).toBeVisible();

    await selectApplication(page, "Test App");
    await page.getByRole("link", { name: /Projet Re:GINE/ }).click();
    const testAppItems = page.getByTestId("catalogue-item");
    await expect(testAppItems).toHaveCount(1);
    await expect(testAppItems.filter({ hasText: "Shared Model A" })).toHaveCount(1);

    await selectApplication(page, "Restricted App");
    await page.getByRole("link", { name: /Projet Demo/ }).click();
    const restrictedItems = page.getByTestId("catalogue-item");
    await expect(restrictedItems).toHaveCount(1);
    await expect(restrictedItems.filter({ hasText: "Shared Model B" })).toHaveCount(1);
  });
});
