import { expect, test } from "@playwright/test";

import { ACTION_LABEL } from "../src/lib/format";

import { api, expectAccessible, restore, setTheme, signUp, waitForProposals, type Account } from "./helpers";

test.describe.configure({ mode: "serial" });

let account: Account;

test.beforeEach(async ({ page }) => {
  if (account) await restore(page, account);
});

test("landing page loads, credits its data sources and passes axe in both themes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The tenders worth your time");
  await expect(page.getByRole("heading", { name: "TED - Tenders Electronic Daily" })).toBeVisible();
  await expect(page.getByRole("link", { name: "CC BY 4.0" })).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await expectAccessible(page, `landing (${theme})`);
  }
});

test("sign up, add a saved search, and the agent's proposals arrive", async ({ page, request }) => {
  account = await signUp(page);
  await page.getByRole("button", { name: "New saved search" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("IT services, Ireland");
  await dialog.getByRole("button", { name: /^CPV codes:/ }).click();
  await page.getByRole("combobox", { name: "Search CPV codes" }).fill("72");
  await page.getByRole("option", { name: /72000000/ }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "IT services, Ireland" })).toBeVisible();
  await waitForProposals(request, account);
});

test("approve, edit then approve, reject, and a decision someone else already made", async ({ page, request }) => {
  await page.goto(`/o/${account.orgId}/approvals`);
  const actions = page.getByRole("heading", { name: "Proposed actions" });
  await expect(actions).toBeVisible();

  // Approve: the action runs and is reported back.
  const track = page.locator("li", { hasText: "Track as an opportunity" }).first();
  await track.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Track as an opportunity: done")).toBeVisible({ timeout: 30_000 });

  // Edit then approve: change the reminder days.
  const reminders = page.locator("li", { hasText: "Add deadline reminders" }).first();
  await reminders.getByRole("button", { name: "Edit and approve" }).click();
  const edit = page.getByRole("dialog");
  await edit.getByRole("button", { name: /Remove 2 days|Remove 7 days/ }).first().click();
  await edit.getByRole("spinbutton").fill("10");
  await edit.getByRole("button", { name: "Add" }).click();
  await edit.getByRole("button", { name: "Approve edited version" }).click();
  await expect(page.getByText("Add deadline reminders: done")).toBeVisible({ timeout: 30_000 });

  // Reject needs a reason.
  const reviewer = page.locator("li", { hasText: "Assign a reviewer" }).first();
  await reviewer.getByRole("button", { name: "Reject" }).click();
  const reject = page.getByRole("dialog");
  await expect(reject.getByRole("button", { name: "Reject" })).toBeDisabled();
  await reject.getByLabel("Reason").fill("We assign reviewers ourselves");
  await reject.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Rejected. Nothing was run.")).toBeVisible();

  // Someone else decides first: the UI says so and runs nothing.
  const pending = (await (await api(request, account).get("/agent-proposals?status=pending&limit=200")).json()).items;
  const target = pending[0];
  await page.goto(`/o/${account.orgId}/approvals?notice=${target.notice_id}`);
  const card = page.locator("li", { hasText: ACTION_LABEL[target.action_type]! }).first();
  await expect(card).toBeVisible();
  await api(request, account).post(`/agent-proposals/${target.id}/reject`, { reason: "Decided by a colleague" });
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Someone has already decided this proposal")).toBeVisible();
  const after = await (await api(request, account).get(`/agent-proposals/${target.id}`)).json();
  expect(after.status).toBe("rejected");
});

test("pipeline: allowed moves only, and a refused move changes nothing", async ({ page, request }) => {
  const list = await (await api(request, account).get("/opportunities")).json();
  const opp = list.items[0];
  expect(opp.allowed_transitions).toEqual(["bid", "no_bid"]);
  const refused = await api(request, account).patch(`/opportunities/${opp.id}/status`, { status: "won" });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("invalid_transition");

  await page.goto(`/o/${account.orgId}/opportunities`);
  const card = page.getByRole("article").filter({ hasText: opp.notice_title.slice(0, 30) });
  await card.getByRole("button", { name: /^Move / }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Bidding", "No bid"]);
  await page.getByRole("menuitem", { name: "Bidding" }).click();
  await expect(page.getByText("Moved to Bidding")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Bidding: 1/ })).toBeVisible();
});

test("reminders show on the opportunity timeline and the audit log records the decisions", async ({ page, request }) => {
  const list = await (await api(request, account).get("/opportunities")).json();
  await page.goto(`/o/${account.orgId}/opportunities/${list.items[0].id}`);
  await expect(page.getByRole("img", { name: /Timeline of \d+ deadlines/ })).toBeVisible();
  await expect(page.getByText("Reminder").first()).toBeVisible();

  await page.goto(`/o/${account.orgId}/audit?actor=human`);
  await expect(page.getByText("approved a proposal").first()).toBeVisible();
  await expect(page.getByText("edited and approved a proposal").first()).toBeVisible();
  await expect(page.getByText("rejected a proposal").first()).toBeVisible();
});

test("every screen passes axe in both themes", async ({ page }) => {
  test.setTimeout(300_000); // ten screens, two themes, a full axe scan each
  const screens = ["", "/approvals", "/opportunities", "/notices", "/matches", "/deadlines", "/searches", "/audit", "/ingestion", "/settings"];
  for (const theme of ["dark", "light"] as const) {
    await page.goto(`/o/${account.orgId}`);
    await setTheme(page, theme);
    for (const screen of screens) {
      await page.goto(`/o/${account.orgId}${screen}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("[aria-label=Loading]")).toHaveCount(0);
      await page.waitForTimeout(800); // entrance animations fade in; measure contrast at rest
      await expectAccessible(page, `${screen || "/overview"} (${theme})`);
    }
  }
});

test("reduced motion and reduced transparency are honoured", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  // Under reduced motion the aurora draws one frame; no animation frame loop keeps running.
  const frames = await page.evaluate(
    () => new Promise<number>((resolve) => {
      let count = 0;
      const canvas = document.querySelector("canvas");
      if (!canvas) return resolve(0);
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      const original = gl?.drawArrays.bind(gl);
      if (gl && original) gl.drawArrays = (...args: Parameters<typeof original>) => { count += 1; original(...args); };
      setTimeout(() => resolve(count), 1000);
    }),
  );
  expect(frames).toBe(0);

  await page.evaluate(() => (document.documentElement.dataset.transparency = "reduced"));
  await page.goto("/sign-in");
  await page.evaluate(() => (document.documentElement.dataset.transparency = "reduced"));
  const filter = await page.locator(".glass").first().evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(filter).toBe("none");
  await context.close();
});
