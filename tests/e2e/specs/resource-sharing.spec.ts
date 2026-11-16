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
  test("one session sees two owners' resources", async ({ page }) => {
    await signInToPortal(page);

    await page.goto(`${AUTH_URL}/share/catalogue`);
    await expect(page.getByTestId("subject-catalogue")).toBeVisible();

    // Every sharing application is listed even before a selection.
    const applications = page.getByTestId("catalogue-applications").getByRole("button");
    await expect(applications).toHaveCount(4);
    await expect(page.getByTestId("catalogue-app-test-app")).toContainText("Test App");
    await expect(page.getByTestId("catalogue-app-restricted-app")).toContainText("Restricted App");

    await page.getByTestId("catalogue-app-test-app").click();
    const testAppItems = page.getByTestId("catalogue-item");
    await expect(testAppItems).toHaveCount(1);
    const modelA = testAppItems.filter({ hasText: "Shared Model A" });
    await expect(modelA).toHaveCount(1);
    await expect(modelA).toContainText("Test App");

    await page.getByTestId("catalogue-app-restricted-app").click();
    const restrictedItems = page.getByTestId("catalogue-item");
    await expect(restrictedItems).toHaveCount(1);
    const modelB = restrictedItems.filter({ hasText: "Shared Model B" });
    await expect(modelB).toHaveCount(1);
    await expect(modelB).toContainText("Restricted App");
  });
});
