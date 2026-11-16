import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { ACTION_LABEL } from "../src/lib/format";

import { api, expectAccessible, quietTips, restore, setTheme, signUp, waitForProposals, type Account } from "./helpers";

test.describe.configure({ mode: "serial" });

let account: Account;

test.beforeEach(async ({ page }) => {
  if (account) await restore(page, account);
});

test("landing page loads, shows a decision step by step, credits its sources and passes axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The tenders worth your time");
  await expect(page.getByRole("heading", { name: "TED - Tenders Electronic Daily" })).toBeVisible();
  await expect(page.getByRole("link", { name: "CC BY 4.0" })).toBeVisible();

  // The example walk-through is clearly marked and ends in a recorded decision.
  await expect(page.getByText("Example, not a real notice")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Done. Recorded in the audit log under your name.")).toBeVisible();

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await expectAccessible(page, `landing (${theme})`);
  }
});

test("guided setup ends with real tenders ready to decide", async ({ page, request }) => {
  test.setTimeout(150_000);
  account = await signUp(page);
  // First visit: the screen introduces itself, and the introduction can be dismissed and brought back.
  await expect(page.getByRole("region", { name: "How this screen works" })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("region", { name: "How this screen works" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "To decide" })).toBeVisible();
  await expect(page.getByRole("region", { name: "How this screen works" })).toHaveCount(0);
  await page.getByRole("button", { name: "How this screen works" }).click();
  await expect(page.getByRole("dialog", { name: "Tenderline Guide" })).toBeVisible();
  await page.getByRole("button", { name: "Close guide" }).click();
  await waitForProposals(request, account, 6);
});

test("Today shows what to do next and the getting-started list tracks real progress", async ({ page }) => {
  await page.goto(`/o/${account.orgId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)|Welcome back/);
  await expect(page.getByText("Do this next")).toBeVisible();
  const list = page.getByRole("region", { name: "Getting started" });
  await expect(list.getByText("Describe your company (done)")).toBeAttached();
  await expect(list.getByText("Create a watchlist (done)")).toBeAttached();
  await expect(list.getByText("Decide your first suggestion (to do)")).toBeAttached();
  // "?" opens the shortcut sheet from anywhere.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("decide: approve all, edit then approve, not for us, and a decision made elsewhere", async ({ page, request }) => {
  await quietTips(page, account.orgId);
  await page.goto(`/o/${account.orgId}/approvals`);
  await expect(page.getByRole("heading", { name: "Suggested actions, one by one" })).toBeVisible();

  // Edit then approve one action: change the reminder days.
  const reminders = page.locator("li", { hasText: "Add deadline reminders" }).first();
  await reminders.getByRole("button", { name: "Edit and approve" }).click();
  const edit = page.getByRole("dialog");
  await edit.getByRole("button", { name: /^Remove \d+ days$/ }).first().click();
  await edit.getByRole("spinbutton").fill("10");
  await edit.getByRole("button", { name: "Add" }).click();
  await edit.getByRole("button", { name: "Approve edited version" }).click();
  await expect(page.getByText("Add deadline reminders: done")).toBeVisible({ timeout: 30_000 });

  // Approve everything that is left for this notice in one step.
  await page.getByRole("button", { name: /^Approve all \(\d\)$/ }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("They run straight away");
  await confirm.getByRole("button", { name: "Approve all", exact: true }).click();
  await expect(page.getByText(/Approved \d actions?\. They are running now\./)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Track in the pipeline: done")).toBeVisible({ timeout: 30_000 });

  // The next notice is selected automatically. Say it is not for us: one reason rejects all its actions.
  await page.getByRole("button", { name: "Not for us" }).click();
  const reject = page.getByRole("dialog");
  await expect(reject.getByRole("button", { name: "Reject all" })).toBeDisabled();
  await reject.getByLabel("Why not?").fill("Outside the regions we deliver in");
  await reject.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByText("Marked as not for us. Nothing was run.")).toBeVisible();

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

  // The strong-fit filter narrows the list and says how many it holds.
  await page.goto(`/o/${account.orgId}/approvals?filter=strong`);
  await expect(page.getByRole("button", { name: /^Strong fit \d+$/ })).toHaveAttribute("aria-pressed", "true");
});

test("pipeline: allowed moves only, a refused move changes nothing, and the tender says what to do next", async ({ page, request }) => {
  await quietTips(page, account.orgId);
  const list = await (await api(request, account).get("/opportunities")).json();
  const opp = list.items[0];
  expect(opp.allowed_transitions).toEqual(["bid", "no_bid"]);
  const refused = await api(request, account).patch(`/opportunities/${opp.id}/status`, { status: "won" });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("invalid_transition");

  await page.goto(`/o/${account.orgId}/opportunities`);
  await expect(page.getByText("Drag here once your response is sent.")).toBeVisible();
  const card = page.getByRole("article").filter({ hasText: opp.notice_title.slice(0, 30) });
  await card.getByRole("button", { name: /^Move / }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Bidding", "No bid"]);
  await page.getByRole("menuitem", { name: "Bidding" }).click();
  await expect(page.getByText("Moved to Bidding")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Bidding: 1/ })).toBeVisible();

  await page.goto(`/o/${account.orgId}/opportunities/${opp.id}`);
  await expect(page.getByText(/Prepare your response|Add reminders so the deadline/)).toBeVisible();
  await expect(page.getByRole("img", { name: /Timeline of \d+ deadlines/ })).toBeVisible();

  // The calendar file is a real iCalendar document with this tender's deadlines.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Add to calendar" }).click();
  const file = await (await download).path();
  const text = await readFile(file, "utf8");
  expect(text).toContain("BEGIN:VCALENDAR");
  expect(text).toContain("Submission deadline:");
});

test("explore notices, turn the filters into a watchlist, and find the decisions in the audit log", async ({ page }) => {
  await quietTips(page, account.orgId);
  await page.goto(`/o/${account.orgId}/notices?cpv=48000000&country=IRL`);
  await page.getByRole("link", { name: "Watch for notices like these" }).click();
  const builder = page.getByRole("dialog", { name: "New watchlist" });
  await expect(builder.getByText("48000000")).toBeVisible();
  await builder.getByLabel("Name").fill("Software, Ireland");
  await builder.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Software, Ireland" })).toBeVisible();

  await page.goto(`/o/${account.orgId}/audit?actor=human`);
  await expect(page.getByText("approved a suggestion").first()).toBeVisible();
  await expect(page.getByText("edited and approved a suggestion").first()).toBeVisible();
  await expect(page.getByText("rejected a suggestion").first()).toBeVisible();
});

test("deadlines by week, audit search, matches by watchlist, live watchlist estimate, palette actions", async ({ page }) => {
  await quietTips(page, account.orgId);
  await page.goto(`/o/${account.orgId}/deadlines`);
  await expect(page.getByText(/^(This week|Next week|Later)$/).first()).toBeVisible();
  await expect(page.getByText("More deadlines on a day")).toBeVisible();

  await page.goto(`/o/${account.orgId}/audit?actor=human`);
  await expect(page.getByRole("heading", { name: "Today" }).first()).toBeVisible();
  await page.getByLabel("Search the log").fill("rejected");
  await expect(page.getByText("rejected a suggestion").first()).toBeVisible();
  await expect(page.getByText("suggested an action")).toHaveCount(0);

  await page.goto(`/o/${account.orgId}/matches`);
  await expect(page.getByRole("heading", { name: "My first watchlist" })).toBeVisible();

  await page.goto(`/o/${account.orgId}/searches`);
  await expect(page.getByRole("heading", { name: "Watchlists", level: 1 })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: "New watchlist" }).click();
  const builder = page.getByRole("dialog", { name: "New watchlist" });
  await builder.getByRole("button", { name: /^CPV codes:|^Categories:/ }).click();
  await page.getByRole("combobox", { name: "Search CPV codes" }).fill("72");
  await page.getByRole("option", { name: /72000000/ }).click();
  await page.keyboard.press("Escape");
  await expect(builder.getByText(/About \d+\+? open notices? match/)).toBeVisible();
});

test("every screen passes axe in both themes, with introductions showing", async ({ page }) => {
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
      await expectAccessible(page, `${screen || "/today"} (${theme})`);
    }
  }
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { name: "Tell us about your company" })).toBeVisible();
  await expectAccessible(page, "setup");
});

test("narrow windows get a bottom bar, and reduced motion and transparency are honoured", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const small = await phone.newPage();
  await restore(small, account);
  await quietTips(small, account.orgId);
  await small.goto(`/o/${account.orgId}`);
  const bar = small.getByRole("navigation", { name: "Main, compact" });
  await expect(bar).toBeVisible();
  await bar.getByRole("link", { name: /To decide/ }).click();
  await expect(small.getByRole("heading", { name: "To decide" })).toBeVisible();
  expect(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await phone.close();

  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  // Under reduced motion the aurora draws one still frame when it starts; no animation loop keeps running.
  await page.waitForSelector("canvas", { state: "attached", timeout: 10_000 });
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const canvas = document.querySelector("canvas");
        if (!canvas) return resolve(0);
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        const original = gl?.drawArrays.bind(gl);
        if (gl && original)
          gl.drawArrays = (...args: Parameters<typeof original>) => {
            count += 1;
            original(...args);
          };
        setTimeout(() => resolve(count), 1000);
      }),
  );
  expect(frames).toBe(0);

  await page.goto("/sign-in");
  await page.evaluate(() => (document.documentElement.dataset.transparency = "reduced"));
  const filter = await page.locator(".glass").first().evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(filter).toBe("none");
  await context.close();
});
