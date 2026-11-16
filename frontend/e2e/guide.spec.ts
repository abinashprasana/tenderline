import { test, expect } from "@playwright/test";
import { expectAccessible, setTheme, signUp, waitForProposals } from "./helpers";

test("guide follows the screen, moves, restores and remains accessible", async ({ page }) => {
  test.setTimeout(180_000);
  const account = await signUp(page, "Guide verification company", "guide");
  let onLeft = false;
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Open Tenderline Guide" }).click();
      await expect(page.getByRole("heading", { name: "Make a confident decision" })).toBeVisible();
      await expectAccessible(page, `guide ${theme} ${width}`);
      await expect(page.getByRole("button", { name: "Move to other side" })).toBeVisible();
      await page.getByRole("button", { name: "Move to other side" }).click();
      onLeft = !onLeft;
      const launcher = page.getByRole("button", { name: "Open Tenderline Guide" });
      await expect.poll(async () => ((await launcher.boundingBox())?.x ?? 0) < width / 2).toBe(onLeft);
      await page.screenshot({ path: `test-results/guide-${theme}-${width}.png`, fullPage: false });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open Tenderline Guide" })).toBeFocused();
    }
  }
  // Guide links navigate, close the panel, and the next opening explains the new screen.
  await page.getByRole("button", { name: "Open Tenderline Guide" }).click();
  await page.getByRole("link", { name: "Follow your tracked tenders" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline", level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Tenderline Guide" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Tenderline Guide" }).click();
  await expect(page.getByRole("heading", { name: "Keep your bids moving" })).toBeVisible();
  await page.getByRole("button", { name: "Hide guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Tenderline Guide" })).toHaveCount(0);
  await page.goto(`/o/${account.orgId}/settings`);
  await page.getByLabel("Show Tenderline Guide", { exact: true }).check();
  await page.getByLabel("Reduce guide animation", { exact: true }).check();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Open Tenderline Guide" }).click();
  await expect(page.getByRole("heading", { name: "Make Tenderline yours" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByLabel("Reduce guide animation", { exact: true })).toBeChecked();
});

test("Wren opens with w, finds tasks, reacts to a decision, greets once and keeps still when asked", async ({ page, request }) => {
  test.setTimeout(180_000);
  // Reactions and the greeting belong to "Lively Wren", which is off by default.
  await page.addInitScript(() => localStorage.setItem("tenderline.tip.guide.lively", "1"));
  const account = await signUp(page, "Wren verification company", "wren");
  // The flat owl in the launcher, or the 3D owl once it has loaded: both carry data-wren and data-mood.
  const wren = page.locator("[data-wren]").first();

  // "w" opens the guide from anywhere; the task finder takes you to the right screen.
  await expect(page.getByRole("heading", { name: "To decide", level: 1 })).toBeVisible();
  await expect(wren).toBeVisible();
  await page.keyboard.press("w");
  const guide = page.getByRole("dialog", { name: "Tenderline Guide" });
  await expect(guide).toBeVisible();
  await expect(guide.getByText("Hi, I'm Wren")).toBeVisible();
  await guide.getByLabel("What do you want to do?").fill("calendar");
  await guide.getByRole("link", { name: /Put a deadline in my calendar/ }).click();
  await expect(page.getByRole("heading", { name: "Deadlines", level: 1 })).toBeVisible();
  await expect(guide).toHaveCount(0);

  // Wren is happy when a suggestion is approved.
  await waitForProposals(request, account, 3);
  await page.goto(`/o/${account.orgId}/approvals`);
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await expect(wren).toHaveAttribute("data-mood", "happy", { timeout: 15_000 });
  await expect(wren).toHaveAttribute("data-mood", /idle|talk/, { timeout: 5_000 });

  // A greeting on Today, once per visit, saying something real.
  await page.evaluate(() => sessionStorage.removeItem("tenderline.wren.greeted"));
  await page.goto(`/o/${account.orgId}`);
  const greeting = page.getByRole("status").filter({ hasText: /waiting for your decision|in the next 7 days|Nothing is waiting/ });
  await expect(greeting).toBeVisible({ timeout: 5_000 });
  await expectAccessible(page, "Wren greeting");
  await page.getByRole("button", { name: "Dismiss greeting" }).click();
  await page.reload();
  await page.waitForTimeout(2_500);
  await expect(greeting).toHaveCount(0);

  // Reduced motion: Wren holds still.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(wren).toHaveAttribute("data-calm", "true");
  const pose = () => wren.locator("[data-part=whole]").evaluate((el) => getComputedStyle(el).transform);
  const before = await pose();
  await page.waitForTimeout(800);
  expect(await pose()).toBe(before);
});

test("3D Wren stands on the edge of what it shows, never over the text, and falls back to the flat owl", async ({ page, request }) => {
  test.setTimeout(180_000);
  const account = await signUp(page, "Wren 3D company", "w3d");
  await waitForProposals(request, account, 3);
  await page.setViewportSize({ width: 1280, height: 800 });
  const wren = page.locator('[data-wren="3d"]');
  await expect(wren).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.locator('[data-wren="2d"]')).toHaveCount(0);

  // The feet are 10% up from the bottom of Wren's box (FEET_FROM_BOTTOM).
  const feet = async () => {
    const box = (await wren.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height * 0.9, box };
  };
  const settled = async () => {
    await expect(wren).toHaveAttribute("data-place", "perch", { timeout: 8_000 });
    await page.waitForTimeout(400);
  };

  // Open the guide: Wren flies up and stands on the panel's top edge, above the text.
  await page.keyboard.press("w");
  const guide = page.getByRole("dialog", { name: "Tenderline Guide" });
  await expect(guide).toBeVisible();
  await settled();
  const panel = (await guide.boundingBox())!;
  const onPanel = await feet();
  expect(Math.abs(onPanel.y - panel.y)).toBeLessThanOrEqual(8);
  expect(onPanel.box.y).toBeGreaterThanOrEqual(0);
  for (const text of [guide.getByText("Hi, I'm Wren"), guide.getByRole("heading", { level: 2 }), guide.getByRole("button", { name: "Close guide" })]) {
    const t = (await text.boundingBox())!;
    // Nothing of the owl's body (above its feet) reaches down to the panel's text.
    expect(onPanel.y).toBeLessThanOrEqual(t.y);
  }

  // "Show me": pick a task and Wren lands on the control, feet on its top edge.
  await guide.getByLabel("What do you want to do?").fill("approve all");
  await guide.getByRole("link", { name: /Approve every action/ }).click();
  await expect(guide).toHaveCount(0);
  await settled();
  const button = (await page.getByRole("button", { name: /^Approve all \(\d\)$/ }).boundingBox())!;
  const onButton = await feet();
  expect(Math.abs(onButton.y - button.y)).toBeLessThanOrEqual(8);
  expect(onButton.x).toBeGreaterThan(button.x);
  expect(onButton.x).toBeLessThan(button.x + button.width);
  await expectAccessible(page, "3D Wren on a control");

  // By default Wren does nothing on its own: no reaction to a decision, no greeting on Today.
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await expect(page.getByText(/: done|Approved/).first()).toBeVisible({ timeout: 30_000 });
  await expect(wren).not.toHaveAttribute("data-mood", "happy");
  await page.evaluate(() => sessionStorage.removeItem("tenderline.wren.greeted"));
  await page.goto(`/o/${account.orgId}`);
  await expect(wren).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await expect(page.getByRole("button", { name: "Dismiss greeting" })).toHaveCount(0);
  await expect(wren).toHaveAttribute("data-mood", "idle");
  await expect(wren).toHaveAttribute("data-place", "home");
  // And it holds still: three pictures 300 ms apart, of which at most one can catch the slow blink.
  await page.mouse.move(200, 200);
  const shots: Buffer[] = [];
  for (let i = 0; i < 3; i += 1) {
    shots.push(await wren.screenshot());
    await page.waitForTimeout(300);
  }
  const same = [shots[0]!.equals(shots[1]!), shots[1]!.equals(shots[2]!), shots[0]!.equals(shots[2]!)];
  expect(same.some(Boolean)).toBe(true);
  // Moving the pointer does not turn its head either.
  await page.mouse.move(1100, 300, { steps: 10 });
  await page.waitForTimeout(700);
  const after = [await wren.screenshot(), await wren.screenshot()];
  expect(after.some((shot) => shots.some((before) => before.equals(shot)))).toBe(true);

  // Phones and reduced motion get the flat owl.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(wren).toHaveCount(0);
  await expect(page.locator('[data-wren="2d"]').first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator('[data-wren="2d"]').first()).toBeVisible();
  await expect(wren).toHaveCount(0);
});
