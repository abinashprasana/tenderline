import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Records the product walkthrough (1920x1080, dark theme): a new company getting started, then a
 * company a few days in using every main screen. Run on demand against the local demo stack:
 *   DEMO=1 DEMO_OWNER=orla E2E_BASE_URL=http://localhost:8090 npx playwright test demo-video
 * The pointer, typing and scrolling are paced like a person: curved, eased pointer moves in real time,
 * uneven gaps between key presses, and smooth scrolling.
 */
test.skip(!process.env.DEMO, "records the demo video only when DEMO=1");
test.setTimeout(30 * 60_000);
// A trace of a long recording is huge and its zip can fail to save; the video is what matters here.
test.use({ trace: "off" });

const W = 1920;
const H = 1080;
const OWNER = process.env.DEMO_OWNER ?? "orla";
/** The brand-new account for part 1. It must not have a company yet, or setup is skipped. */
const NEWCOMER = process.env.DEMO_NEW_LOGIN ?? "aisling.byrne";

/** Captions, a visible cursor and a click ripple, installed before any page script runs. */
const OVERLAY = () => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
        transform:translate(-3px,-2px)}
      #demo-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        border:2px solid #5fd6c0;z-index:2147483646;pointer-events:none;animation:demo-r .5s ease-out forwards}
      @keyframes demo-r{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
      #demo-caption{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483645;
        max-width:1200px;padding:14px 26px;border-radius:999px;background:rgba(8,20,28,.88);color:#f2f7f9;
        font:600 22px/1.35 "Schibsted Grotesk Variable",system-ui,sans-serif;letter-spacing:-.01em;text-align:center;
        border:1px solid rgba(95,214,192,.45);box-shadow:0 18px 50px -18px rgba(0,0,0,.7);pointer-events:none}
      #demo-caption small{display:block;font-weight:500;font-size:16px;color:#a9c2cb;margin-top:2px}
      #demo-card{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;
        background:radial-gradient(60rem 40rem at 30% 20%,#0f4f4a,transparent 60%),#07131a;color:#eef6f7;
        font-family:"Schibsted Grotesk Variable",system-ui,sans-serif;transition:opacity .6s ease}
      #demo-card h1{font-size:76px;margin:0;letter-spacing:-.03em} #demo-card p{font-size:28px;color:#9ec3c9;margin:.4em 0 0}
      #demo-card .chapter{font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:#5fd6c0;margin:0 0 .6em}`;
    document.documentElement.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.4L21 11z" fill="#fff" stroke="#0b1a22" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
    const saved = sessionStorage.getItem("demo-xy");
    if (saved) cursor.style.transform = `translate(${saved})`;
    addEventListener("mousemove", (e) => {
      const xy = `${e.clientX - 3}px,${e.clientY - 2}px`;
      cursor.style.transform = `translate(${xy})`;
      sessionStorage.setItem("demo-xy", xy);
    }, true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "demo-ripple";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    const caption = sessionStorage.getItem("demo-caption");
    if (caption) (window as unknown as { __caption: (t: string) => void }).__caption(caption);
  };
  (window as unknown as { __caption: (t: string) => void }).__caption = (html: string) => {
    sessionStorage.setItem("demo-caption", html);
    let el = document.getElementById("demo-caption");
    if (!html) return el?.remove();
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      document.documentElement.appendChild(el);
    }
    el.innerHTML = html;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
};

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const between = (min: number, max: number) => min + Math.random() * (max - min);

async function say(page: Page, text: string, sub?: string, hold = 2600) {
  if (text) console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
  await page.evaluate(([t, s]) => (window as unknown as { __caption: (h: string) => void }).__caption(t ? `${t}${s ? `<small>${s}</small>` : ""}` : ""), [text, sub ?? ""] as const);
  await pause(page, hold);
}

async function card(page: Page, title: string, sub: string, hold = 3200, chapter = "") {
  await page.evaluate(([t, s, c]) => {
    const el = document.createElement("div");
    el.id = "demo-card";
    el.innerHTML = `<div style="text-align:center">${c ? `<p class="chapter">${c}</p>` : ""}<h1>${t}</h1><p>${s}</p></div>`;
    document.documentElement.appendChild(el);
  }, [title, sub, chapter] as const);
  await pause(page, hold);
  await page.evaluate(() => {
    const el = document.getElementById("demo-card");
    if (el) {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 700);
    }
  });
  await pause(page, 700);
}

let mouse = { x: W / 2, y: H / 2 };

/**
 * Scrolls smoothly, easing in and out, in a set time whatever the machine's speed: each step scrolls
 * by however much the clock says should have scrolled so far.
 */
async function scroll(page: Page, pixels: number) {
  const duration = Math.max(250, Math.min(900, Math.abs(pixels) * 0.6));
  const start = Date.now();
  let done = 0;
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const want = Math.round(pixels * e);
    if (want !== done) {
      await page.mouse.wheel(0, want - done);
      done = want;
    }
    if (t >= 1) break;
    await pause(page, 8);
  }
  await pause(page, 350);
}

/** Brings a control into comfortable view by scrolling smoothly, instead of jumping to it. */
async function bringIntoView(page: Page, target: Locator) {
  await target.waitFor({ state: "visible" });
  for (let i = 0; i < 6; i++) {
    const box = await target.boundingBox();
    if (!box) break;
    if (box.y >= 90 && box.y + box.height <= H - 150) return;
    const delta = box.y < 90 ? box.y - 160 : box.y + box.height - (H - 260);
    await scroll(page, Math.round(Math.max(-1400, Math.min(1400, delta))));
  }
  // Inside a scrolling panel the wheel may not reach it; fall back to a direct scroll.
  await target.scrollIntoViewIfNeeded();
}

/**
 * Moves the pointer like a hand: an eased, slightly curved path in real time (about 60 steps a second),
 * taking longer for longer trips, landing near but not exactly on the centre of the target.
 */
async function moveTo(page: Page, target: Locator) {
  await bringIntoView(page, target);
  const box = await target.boundingBox();
  if (!box) throw new Error("target not visible");
  const x = box.x + box.width * between(0.4, 0.6);
  const y = box.y + Math.min(box.height * between(0.4, 0.6), 22);
  const dx = x - mouse.x;
  const dy = y - mouse.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return;
  const duration = Math.max(280, Math.min(950, 220 + distance * 0.55));
  // A gentle bow to one side of the straight line, as a wrist would make.
  const bow = distance * between(0.06, 0.14) * (Math.random() < 0.5 ? -1 : 1);
  const cx = mouse.x + dx / 2 - (dy / (distance || 1)) * bow;
  const cy = mouse.y + dy / 2 + (dx / (distance || 1)) * bow;
  const from = { ...mouse };
  // Timed against the clock, not a fixed number of steps: on a busy machine each step takes longer, so
  // a step count would slow the whole movement down. This way it always arrives in `duration`.
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const a = (1 - e) ** 2;
    const b = 2 * (1 - e) * e;
    const c = e ** 2;
    await page.mouse.move(a * from.x + b * cx + c * x, a * from.y + b * cy + c * y);
    if (t >= 1) break;
    await pause(page, 8);
  }
  mouse = { x, y };
}

async function click(page: Page, target: Locator, after = 900) {
  await moveTo(page, target);
  await pause(page, between(140, 260));
  await page.mouse.down();
  await pause(page, between(60, 110));
  await page.mouse.up();
  await pause(page, after);
}

async function hover(page: Page, target: Locator, hold = 1600) {
  await moveTo(page, target);
  await pause(page, hold);
}

/** Types like a person: uneven gaps between keys, a little longer after spaces and punctuation. */
async function type(page: Page, target: Locator, text: string) {
  await click(page, target, 300);
  for (const ch of text) {
    await page.keyboard.type(ch);
    let gap = between(90, 200);
    if (ch === " ") gap += between(40, 120);
    if (",.".includes(ch)) gap += between(150, 300);
    if (Math.random() < 0.04) gap += between(250, 500);
    await pause(page, gap);
  }
  await pause(page, 500);
}

/** On To decide, moves to the next notice (with j) until one has the given control. */
async function noticeWith(page: Page, control: Locator) {
  for (let i = 0; i < 8 && !(await control.isVisible()); i++) {
    await page.keyboard.press("j");
    await pause(page, 900);
  }
  await expect(control).toBeVisible();
}

/** Clicks a control that opens a dialog, and makes sure it opened (the page may still be settling). */
async function openDialog(page: Page, control: Locator) {
  await click(page, control, 500);
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await pause(page, 1000);
    if (!(await dialog.isVisible())) await control.click();
  }
  await expect(dialog).toBeVisible();
  await pause(page, 500);
  return dialog;
}

async function newContext(browser: import("@playwright/test").Browser, dir: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    recordVideo: { dir, size: { width: W, height: H } },
    acceptDownloads: true,
  });
  // Fail fast on a missing element instead of waiting forever with the camera running.
  context.setDefaultTimeout(20_000);
  await context.addInitScript(OVERLAY);
  return context;
}

test("record the Tenderline walkthrough @video", async ({ browser, baseURL }) => {
  const dir = "test-results/demo-video";
  const context = await newContext(browser, dir);
  const page = await context.newPage();
  await page.mouse.move(mouse.x, mouse.y);

  /* ================================================================== what it is */
  await page.goto("/");
  await card(page, "Tenderline", "Public tenders worth your time, found for you and decided by you", 3400);
  await say(page, "Tenderline watches Irish and EU tender notices for your company", "An assistant assesses each one, and nothing happens until a person approves it", 4000);
  await scroll(page, 900);
  await say(page, "Every new notice goes through the same steps", "Matched to your watchlists, assessed, then decided by someone on your team", 4000);
  await scroll(page, 320);
  await say(page, "Visitors can try one decision on the page, step by step", undefined, 2800);
  await scroll(page, -1320);

  /* ================================================================== 1. getting started */
  await card(page, "Getting started", "A new company is set up in about a minute", 2600, "Part 1");
  await say(page, "Sign in", "The live product uses GitHub sign-in. This demo uses a local account", 400);
  await click(page, page.getByRole("link", { name: /Try it now|Sign in/ }).first(), 900);
  await type(page, page.getByLabel("Local account name"), NEWCOMER);
  await click(page, page.getByRole("button", { name: "Sign in locally" }), 1400);

  await say(page, "Describe your company", "The assistant reads this to judge how well each notice fits you", 600);
  await type(page, page.getByLabel("Company name"), "Shannon Civil Design");
  await type(page, page.getByLabel("What you do"), "Civil engineering design for councils");
  await click(page, page.getByRole("button", { name: "Continue" }), 1200);

  await say(page, "Choose what to watch for", "Start with one or two areas. You can add keywords, buyers and countries later", 600);
  await click(page, page.getByRole("button", { name: "Engineering and design", exact: true }), 600);
  await click(page, page.getByRole("button", { name: "Construction", exact: true }), 900);
  await click(page, page.getByRole("button", { name: "Find my tenders" }), 600);

  await say(page, "Tenderline finds matching notices and the assistant assesses them", "This is the real pipeline running, not an animation", 800);
  await expect(page.getByRole("heading", { name: "Your first tenders are ready" })).toBeVisible({ timeout: 120_000 });
  await pause(page, 1800);
  await click(page, page.getByRole("button", { name: "Decide your first one" }), 1800);
  await say(page, "The first suggestions are already waiting for a decision", undefined, 3000);

  /* ================================================================== 2. a working company */
  await card(page, "A few days later", "Liffey Digital has used Tenderline for a while", 3000, "Part 2");
  await page.goto("/sign-in");
  await page.evaluate(() => sessionStorage.removeItem("tenderline.session"));
  await page.reload();
  await page.evaluate(() => {
    for (const id of ["today", "decide", "pipeline", "notices", "watchlists", "matched", "deadlines", "audit", "sources"])
      localStorage.setItem(`tenderline.tip.intro.${id}`, "1");
  });
  await type(page, page.getByLabel("Local account name"), OWNER);
  await click(page, page.getByRole("button", { name: "Sign in locally" }), 400);
  await page.waitForURL(/\/o\/[0-9a-f-]+$/);
  const orgId = page.url().match(/\/o\/([0-9a-f-]+)/)![1]!;
  await page.evaluate((org) => {
    localStorage.setItem(`tenderline.tip.checklist.${org}`, "1");
    localStorage.setItem(`tenderline.visit.${org}`, JSON.stringify({ previous: Date.now() - 26 * 3600_000, current: Date.now() - 2 * 3600_000 }));
  }, orgId);
  await page.reload();
  await expect(page.getByText("Do this next")).toBeVisible();

  /* ------------------------------------------------------------------ Today */
  await say(page, "Today tells you the one thing to do next", "A close deadline, a strong fit, or a tender the buyer changed", 600);
  await hover(page, page.getByText("Do this next"), 2600);
  await say(page, "Beside it: what changed since your last visit, and your progress", undefined, 2600);
  await scroll(page, 560);
  await say(page, "The next 30 days, with the nearest deadlines named", "And how the tenders you track are doing", 3400);
  await scroll(page, 480);
  await say(page, "How well the waiting notices fit, and what the team did lately", undefined, 3200);
  await scroll(page, -1400);

  /* ------------------------------------------------------------------ To decide */
  await say(page, "To decide: the notices the assistant thinks fit you, best first", "Each has a fit score from 0 to 100", 600);
  await click(page, page.getByRole("link", { name: /To decide/ }).first(), 2000);
  await say(page, "Filter by strong fits, closing soon, or changed by the buyer", undefined, 400);
  await click(page, page.getByRole("button", { name: /^Strong fit \d+$/ }), 1800);
  await hover(page, page.getByText("Why it may fit").first(), 400);
  await say(page, "Read why it fits and the risks, then check each suggested action", "The assistant's text is always marked as a suggestion", 3200);

  const reminders = page.locator("li", { hasText: "Add deadline reminders" }).first().getByRole("button", { name: "Edit and approve" });
  await noticeWith(page, reminders);
  await say(page, "Change a suggestion before you approve it", "Here: when the deadline reminders go out", 400);
  const edit = await openDialog(page, reminders);
  await click(page, edit.getByRole("button", { name: /^Remove \d+ days$/ }).first(), 600);
  await type(page, edit.getByRole("spinbutton"), "21");
  await click(page, edit.getByRole("button", { name: "Add" }), 800);
  await click(page, edit.getByRole("button", { name: "Approve edited version" }), 2400);

  const approveAll = page.getByRole("button", { name: /^Approve all \(\d\)$/ });
  await noticeWith(page, approveAll);
  await say(page, "Happy with every suggestion? Approve them all in one go", "Each one still runs separately, with your name on it", 400);
  const confirm = await openDialog(page, approveAll);
  await click(page, confirm.getByRole("button", { name: "Approve all", exact: true }), 2600);

  const notForUs = page.getByRole("button", { name: "Not for us" });
  await noticeWith(page, notForUs);
  await say(page, "Not interested? Say why, and none of its suggestions run", undefined, 400);
  const reject = await openDialog(page, notForUs);
  await type(page, reject.getByLabel("Why not?"), "Outside the regions we deliver in");
  await click(page, reject.getByRole("button", { name: "Reject all" }), 2000);

  /* ------------------------------------------------------------------ Pipeline and a tender */
  await say(page, "The pipeline: every tender you track, from new to won or lost", undefined, 400);
  await click(page, page.getByRole("link", { name: "Pipeline" }).first(), 2200);
  const newCard = page.getByRole("region", { name: /^New:/ }).getByRole("article").first();
  if (await newCard.count()) {
    await say(page, "Use Move on a card, or drag it to another column", "Only moves that make sense are offered", 400);
    await click(page, newCard.getByRole("button", { name: /^Move / }), 1000);
    await click(page, page.getByRole("menuitem", { name: "Bidding" }), 2000);
  }
  await say(page, "Open a tender to see everything about it", undefined, 400);
  await click(page, page.getByRole("region", { name: /^Bidding:/ }).getByRole("article").first().getByRole("link").first(), 2600);
  await say(page, "What to do next, where it can move, and every deadline on one timeline", undefined, 2800);
  await scroll(page, 480);
  await say(page, "Reminders count back from the submission deadline", undefined, 400);
  await openDialog(page, page.getByRole("button", { name: "Reminders" }));
  await pause(page, 1800);
  await page.keyboard.press("Escape");
  await pause(page, 600);
  await say(page, "Put its deadlines in your own calendar in one click", "Outlook, Google or Apple Calendar", 400);
  const download = page.waitForEvent("download").catch(() => null);
  await click(page, page.getByRole("button", { name: "Add to calendar" }), 1600);
  await download;
  await scroll(page, 700);
  await say(page, "Its history: every decision and change, in order", undefined, 2800);
  await scroll(page, -1600);

  /* ------------------------------------------------------------------ Deadlines */
  await say(page, "Deadlines: everything due across all your tenders, week by week", undefined, 400);
  await click(page, page.getByRole("link", { name: /^Deadlines/ }).first(), 2600);
  const day = page.getByRole("region", { name: "Month view" }).getByRole("button", { name: /: [1-9]\d* deadlines?$/ }).first();
  if (await day.count()) {
    await say(page, "Pick a day on the calendar to see only that day", undefined, 400);
    await click(page, day, 2200);
    await click(page, page.getByRole("button", { name: "Show all" }), 1200);
  }

  /* ------------------------------------------------------------------ Matched notices */
  await say(page, "Matched notices: everything your watchlists caught, and why", "Grouped by the watchlist that caught each one", 400);
  await click(page, page.getByRole("link", { name: "Matched notices" }).first(), 3000);
  await scroll(page, 500);
  await pause(page, 1200);
  await scroll(page, -500);

  /* ------------------------------------------------------------------ All notices and watchlists */
  await say(page, "All notices: search everything, not only your matches", undefined, 400);
  await click(page, page.getByRole("link", { name: "All notices" }).first(), 400);
  await expect(page.getByRole("list").locator("li button").first()).toBeVisible();
  await pause(page, 600);
  await type(page, page.getByLabel("Words in title or summary"), "cloud");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list").locator("li button").first()).toBeVisible();
  await pause(page, 1200);
  await say(page, "Open a notice for its key facts, categories and every version", "When a buyer corrects a notice, both versions are kept", 400);
  await click(page, page.getByRole("list").locator("li button").first(), 3200);
  await page.keyboard.press("Escape");
  await pause(page, 800);
  await say(page, "Found a good set? Turn the search into a watchlist", "It shows how many open notices would match before you save", 400);
  await openDialog(page, page.getByRole("link", { name: "Watch for notices like these" }));
  await pause(page, 2600);
  await click(page, page.getByRole("dialog").getByRole("button", { name: "Cancel" }), 1400);
  await say(page, "Your watchlists, and how many notices each one has caught", undefined, 2800);

  /* ------------------------------------------------------------------ Wren */
  await say(page, "Not sure how to do something? Ask Wren, the guide", "It stays in the corner until you need it", 600);
  await click(page, page.getByRole("button", { name: /open Tenderline Guide/ }), 3000);
  await say(page, "Wren explains the screen you are on, with tips and next steps", undefined, 2600);
  await say(page, "Type what you want to do, and Wren shows you where", undefined, 300);
  await type(page, page.getByLabel("What do you want to do?"), "calendar");
  await pause(page, 600);
  await click(page, page.getByRole("link", { name: /Put a deadline in my calendar/ }), 4400);

  /* ------------------------------------------------------------------ Records and settings */
  await say(page, "The audit log keeps every suggestion and decision", "Who did what, and when", 400);
  await click(page, page.getByRole("link", { name: "Audit log" }).first(), 1600);
  await click(page, page.getByRole("button", { name: "Details" }).first(), 2600);
  await say(page, "Data sources: where notices come from and when they were last collected", undefined, 400);
  await click(page, page.getByRole("link", { name: "Data sources" }).first(), 3000);
  await say(page, "Settings: the company profile the assistant reads, and your team", "Reviewers can decide suggestions; viewers can only look", 400);
  await click(page, page.getByRole("link", { name: "Settings" }).first(), 2600);
  await scroll(page, 500);
  await pause(page, 1600);
  await scroll(page, -800);

  /* ------------------------------------------------------------------ Search anywhere */
  await say(page, "Ctrl and K: jump anywhere, search notices, run common actions", undefined, 600);
  await page.keyboard.press("Control+k");
  await pause(page, 900);
  for (const ch of "strong") {
    await page.keyboard.type(ch);
    await pause(page, between(110, 190));
  }
  await pause(page, 1500);
  await page.keyboard.press("Enter");
  await pause(page, 2400);
  await say(page, "", undefined, 300);

  await card(page, "Tenderline", "The assistant suggests and you decide", 4200);
  await context.close();
  const video = await page.video()?.path();
  console.log("VIDEO", video, "base", baseURL);
});
