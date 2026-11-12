import { expect, test } from "@playwright/test";

import { setTheme, signUp, waitForProposals } from "./helpers";

/**
 * Captures the real approvals screen for the landing page (public/screens/approvals-{dark,light}.png).
 * Run on demand: `CAPTURE=1 npx playwright test capture`. It needs the dev stack with notices in the database.
 */
test("capture the approvals screen for the landing page @capture", async ({ page, request }) => {
  const account = await signUp(page, "Liffey Digital Ltd", "bids");
  await page.getByRole("button", { name: "New saved search" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("IT services, Ireland");
  await dialog.getByRole("button", { name: /^CPV codes:/ }).click();
  await page.getByRole("combobox", { name: "Search CPV codes" }).fill("72");
  await page.getByRole("option", { name: /72000000/ }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Create" }).click();
  await waitForProposals(request, account, 18);

  for (const theme of ["dark", "light"] as const) {
    await page.goto(`/o/${account.orgId}/approvals`);
    await setTheme(page, theme);
    await expect(page.getByRole("heading", { name: "Proposed actions" })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(800); // let the fit rings and entrance motion settle
    await page.screenshot({ path: `public/screens/approvals-${theme}.jpg`, type: "jpeg", quality: 82 });
  }
});
