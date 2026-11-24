import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface Account {
  session: string;
  token: string;
  userId: string;
  login: string;
  orgId: string;
}

/**
 * Goes through the real first-run flow: sign in with a fresh local account, describe the company, pick what
 * to watch for, and wait on the "finding your tenders" step until the first suggestions are ready.
 */
export async function signUp(page: Page, company = "Liffey Digital Ltd", loginPrefix = "e2e"): Promise<Account> {
  const login = `${loginPrefix}-${Date.now().toString(36)}`;
  await page.goto("/sign-in");
  await page.getByLabel("Local account name").fill(login);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page).toHaveURL(/\/welcome$/);

  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("What you do").fill("Managed IT and cloud hosting for Irish public bodies, with a security operations team.");
  await page.getByLabel("What you are good at (optional)").fill("cloud hosting, cyber security, managed IT services, software development");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "What should Tenderline watch for?" })).toBeVisible();
  await page.getByRole("button", { name: "IT services", exact: true }).click();
  await page.getByRole("button", { name: "Find my tenders" }).click();

  // The last step narrates the real pipeline and unlocks when the assistant has finished the first notice.
  await expect(page.getByRole("heading", { name: "Your first tenders are ready" })).toBeVisible({ timeout: 90_000 });
  const session = await page.evaluate(() => sessionStorage.getItem("tenderline.session") ?? "{}");
  await page.getByRole("button", { name: "Decide your first one" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]+\/approvals/);
  const orgId = page.url().match(/\/o\/([0-9a-f-]+)\//)![1]!;
  const parsed = JSON.parse(session);
  return { session, token: parsed.token, userId: parsed.userId, login, orgId };
}

/** Each test gets a fresh browser context; this puts the signed-in session back before any page script runs. */
export async function restore(page: Page, account: Account) {
  await page.addInitScript((raw) => sessionStorage.setItem("tenderline.session", raw), account.session);
}

/** Hides page introductions and the getting-started list, for tests that are not about them. */
export async function quietTips(page: Page, orgId: string) {
  await page.addInitScript((org) => {
    for (const id of ["today", "decide", "pipeline", "notices", "watchlists", "matched", "deadlines", "audit", "sources"]) {
      localStorage.setItem(`tenderline.tip.intro.${id}`, "1");
    }
    localStorage.setItem(`tenderline.tip.checklist.${org}`, "1");
  }, orgId);
}

export function api(request: APIRequestContext, account: Account) {
  const headers = { Authorization: `Bearer ${account.token}` };
  const base = `/v1/organisations/${account.orgId}`;
  return {
    get: (path: string) => request.get(`${base}${path}`, { headers }),
    post: (path: string, data: unknown, key = crypto.randomUUID()) =>
      request.post(`${base}${path}`, { headers: { ...headers, "Idempotency-Key": key }, data }),
    patch: (path: string, data: unknown) => request.patch(`${base}${path}`, { headers, data }),
  };
}

/** Waits until the agent has proposed at least `count` actions (the dev stack uses the fake provider). */
export async function waitForProposals(request: APIRequestContext, account: Account, count = 3) {
  await expect
    .poll(async () => (await (await api(request, account).get("/agent-proposals?status=pending&limit=200")).json()).items.length, {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBeGreaterThanOrEqual(count);
}

/** axe-core with WCAG 2.1 AA rules; any serious or critical finding fails the test. */
export async function expectAccessible(page: Page, label: string) {
  // Colours are still moving just after a theme switch or an entrance: judge the finished screen.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  // Soft, so one run reports every screen with a problem instead of stopping at the first.
  expect.soft(
    blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`),
    `accessibility on ${label}`,
  ).toEqual([]);
}

export async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((t) => {
    localStorage.setItem("tenderline.theme", t);
    document.documentElement.dataset.theme = t;
  }, theme);
}
