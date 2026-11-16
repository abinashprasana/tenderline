import { expect, test, type Page } from "@playwright/test";

import { quietTips, restore, setTheme, signUp, waitForProposals, type Account } from "./helpers";

/**
 * Captures the real "To decide" screen for the landing page (public/screens/approvals-{dark,light}.jpg).
 * Run on demand: `CAPTURE=1 npx playwright test capture`. It needs a stack with notices in the database.
 * With CAPTURE_LOGIN it signs in as that existing account (for example the demo company's owner), so the
 * picture shows realistic names rather than a throwaway test login.
 */
async function signIn(page: Page, login: string): Promise<Account> {
  await page.goto("/sign-in");
  await page.getByLabel("Local account name").fill(login);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await page.waitForURL(/\/o\/[0-9a-f-]+/);
  const session = await page.evaluate(() => sessionStorage.getItem("tenderline.session") ?? "{}");
  const parsed = JSON.parse(session);
  const orgId = page.url().match(/\/o\/([0-9a-f-]+)/)![1]!;
  return { session, token: parsed.token, userId: parsed.userId, login, orgId };
}

test("capture the To decide screen for the landing page @capture", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const login = process.env.CAPTURE_LOGIN;
  const account = login ? await signIn(page, login) : await signUp(page, "Liffey Digital Ltd", "bids");
  if (!login) await waitForProposals(request, account, 18);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const shot = await context.newPage();
  await restore(shot, account);
  await quietTips(shot, account.orgId);
  // The guide is not part of the screen being shown.
  await shot.addInitScript(() => localStorage.setItem("tenderline.tip.guide.hidden", "1"));
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
