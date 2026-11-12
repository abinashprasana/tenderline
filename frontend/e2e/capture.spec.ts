import { expect, test } from "@playwright/test";

import { quietTips, restore, setTheme, signUp, waitForProposals } from "./helpers";

/**
 * Captures the real "To decide" screen for the landing page (public/screens/approvals-{dark,light}.jpg).
 * Run on demand: `CAPTURE=1 npx playwright test capture`. It needs the dev stack with notices in the database.
 */
test("capture the To decide screen for the landing page @capture", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const account = await signUp(page, "Liffey Digital Ltd", "bids");
  await waitForProposals(request, account, 18);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const shot = await context.newPage();
  await restore(shot, account);
  await quietTips(shot, account.orgId);
  for (const theme of ["dark", "light"] as const) {
    await shot.goto(`/o/${account.orgId}/approvals`);
    await setTheme(shot, theme);
    await expect(shot.getByRole("heading", { name: "Suggested actions, one by one" })).toBeVisible();
    await shot.mouse.move(0, 0);
    await shot.waitForTimeout(800); // let the fit rings and entrance motion settle
    await shot.screenshot({ path: `public/screens/approvals-${theme}.jpg`, type: "jpeg", quality: 82 });
  }
  await context.close();
});
