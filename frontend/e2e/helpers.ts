import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface Account {
  session: string;
  token: string;
  userId: string;
  login: string;
  orgId: string;
}

/** Signs in through the UI with a fresh local account and creates its organisation through the welcome screen. */
export async function signUp(page: Page, company = "Liffey Digital Ltd", loginPrefix = "e2e"): Promise<Account> {
  const login = `${loginPrefix}-${Date.now().toString(36)}`;
  await page.goto("/sign-in");
  await page.getByLabel("Local account name").fill(login);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("What you do").fill("Managed IT and cloud hosting for Irish public bodies, with a security operations team.");
  await page.getByLabel("Capabilities").fill("cloud hosting, cyber security, managed IT services, software development");
  await page.getByRole("button", { name: "Create and add a saved search" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]+\/searches$/);
  const orgId = page.url().match(/\/o\/([0-9a-f-]+)\//)![1]!;
  const raw = await page.evaluate(() => sessionStorage.getItem("tenderline.session") ?? "{}");
  const session = JSON.parse(raw);
  return { session: raw, token: session.token, userId: session.userId, login, orgId };
}

/** Each test gets a fresh browser context; this puts the signed-in session back before any page script runs. */
export async function restore(page: Page, account: Account) {
  await page.addInitScript((raw) => sessionStorage.setItem("tenderline.session", raw), account.session);
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
