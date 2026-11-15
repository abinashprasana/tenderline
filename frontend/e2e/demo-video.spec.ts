import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Records the product demo video (1920x1080). Run on demand against the local stack:
 *   DEMO=1 DEMO_OWNER=orla DEMO_CHANGED_NOTICE=<id> E2E_BASE_URL=http://localhost:8080 npx playwright test demo-video
 * Part 1 is a brand-new account going through setup; part 2 is a prepared company a few days in.
 */
test.skip(!process.env.DEMO, "records the demo video only when DEMO=1");
test.setTimeout(30 * 60_000);

const W = 1920;
const H = 1080;
const OWNER = process.env.DEMO_OWNER ?? "orla";
const CHANGED = process.env.DEMO_CHANGED_NOTICE;

/** Captions, a visible cursor and a click ripple, installed before any page script runs. */
const OVERLAY = () => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
        transform:translate(-3px,-2px);transition:transform 60ms linear}
      #demo-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        border:2px solid #5fd6c0;z-index:2147483646;pointer-events:none;animation:demo-r .5s ease-out forwards}
      @keyframes demo-r{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
      #demo-caption{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483645;
        max-width:1200px;padding:14px 26px;border-radius:999px;background:rgba(8,20,28,.86);color:#f2f7f9;
        font:600 22px/1.35 "Schibsted Grotesk Variable",system-ui,sans-serif;letter-spacing:-.01em;text-align:center;
        border:1px solid rgba(95,214,192,.45);box-shadow:0 18px 50px -18px rgba(0,0,0,.7);pointer-events:none;
        transition:opacity .35s ease}
      #demo-caption small{display:block;font-weight:500;font-size:16px;color:#a9c2cb;margin-top:2px}
      #demo-card{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;
        background:radial-gradient(60rem 40rem at 30% 20%,#0f4f4a,transparent 60%),#07131a;color:#eef6f7;
        font-family:"Schibsted Grotesk Variable",system-ui,sans-serif;transition:opacity .6s ease}
      #demo-card h1{font-size:76px;margin:0;letter-spacing:-.03em} #demo-card p{font-size:28px;color:#9ec3c9;margin:.4em 0 0}`;
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

async function say(page: Page, text: string, sub?: string, hold = 2600) {
  if (text) console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
  await page.evaluate(([t, s]) => (window as unknown as { __caption: (h: string) => void }).__caption(t ? `${t}${s ? `<small>${s}</small>` : ""}` : ""), [text, sub ?? ""] as const);
  await pause(page, hold);
}

async function card(page: Page, title: string, sub: string, hold = 3200) {
  await page.evaluate(([t, s]) => {
    const el = document.createElement("div");
    el.id = "demo-card";
    el.innerHTML = `<div style="text-align:center"><h1>${t}</h1><p>${s}</p></div>`;
    document.documentElement.appendChild(el);
  }, [title, sub] as const);
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

async function moveTo(page: Page, target: Locator, steps = 28) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("target not visible");
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 24);
  // An eased path, so the cursor glides rather than jumps.
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(mouse.x + (x - mouse.x) * e, mouse.y + (y - mouse.y) * e);
  }
  mouse = { x, y };
}

async function click(page: Page, target: Locator, after = 900) {
  await moveTo(page, target);
  await pause(page, 220);
  await page.mouse.down();
  await page.mouse.up();
  await pause(page, after);
}

async function hover(page: Page, target: Locator, hold = 1600) {
  await moveTo(page, target);
  await pause(page, hold);
}

async function type(page: Page, target: Locator, text: string) {
  await click(page, target, 250);
  await target.pressSequentially(text, { delay: 45 });
  await pause(page, 500);
}

async function scroll(page: Page, pixels: number, step = 90) {
  const n = Math.max(1, Math.round(Math.abs(pixels) / step));
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, Math.sign(pixels) * step);
    await pause(page, 45);
  }
  await pause(page, 500);
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

test("record the Tenderline demo @video", async ({ browser, baseURL }) => {
  const dir = "test-results/demo-video";
  const context = await newContext(browser, dir);
  const page = await context.newPage();
  await page.mouse.move(mouse.x, mouse.y);

  /* ------------------------------------------------------------------ part 1: first visit */
  if (process.env.DEMO_PART !== "2") {
  await page.goto("/");
  await card(page, "📜 Tenderline", "Public tenders, found, judged and tracked");
  await say(page, "Irish and EU public tenders, found and assessed for you", "Nothing happens until a person says yes", 3200);
  await hover(page, page.getByRole("heading", { level: 1 }), 1200);
  await scroll(page, 900);
  await say(page, "How it works: from a buyer's notice to your decision", undefined, 3800);
  await scroll(page, 700);
  await say(page, "A quick example of one decision", "Marked as an example; nothing here is real data", 1800);
  await click(page, page.getByRole("button", { name: "Next" }), 1600);
  await click(page, page.getByRole("button", { name: "Next" }), 1600);
  await click(page, page.getByRole("button", { name: "Approve", exact: true }), 2200);
  await scroll(page, 1000);
  await say(page, "The real “To decide” screen, and the open data it is built on", undefined, 2600);
  await scroll(page, 1100);
  await pause(page, 1600);
  await scroll(page, -5000, 400);

  await say(page, "Let's start as a brand-new company", undefined, 1200);
  await click(page, page.getByRole("link", { name: /Try it now|Sign in/ }).first(), 1200);
  await say(page, "Sign in", "On this development server: any name, no password", 1000);
  await type(page, page.getByLabel("Local account name"), `sean-${Date.now().toString(36).slice(-4)}`);
  await click(page, page.getByRole("button", { name: "Sign in locally" }), 1600);

  await say(page, "Step 1 · Tell Tenderline what your company does", "The assistant reads this to judge fit", 1200);
  await type(page, page.getByLabel("Company name"), "Corrib Engineering Ltd");
  await type(page, page.getByLabel("What you do"), "Civil and structural engineering design for local authorities, with project management on site.");
  await type(page, page.getByLabel("What you are good at (optional)"), "structural design, civil engineering, project management");
  await click(page, page.getByRole("button", { name: "Continue" }), 1400);

  await say(page, "Step 2 · Choose what to watch for", "One-click starting points, or search every EU category", 1400);
  await click(page, page.getByRole("button", { name: "Engineering and design", exact: true }), 700);
  await click(page, page.getByRole("button", { name: "Construction", exact: true }), 1000);
  await click(page, page.getByRole("button", { name: "Find my tenders" }), 600);

  await say(page, "Step 3 · Tenderline finds matching notices and the assistant assesses them", "Live: this is the real pipeline running", 1000);
  await expect(page.getByRole("heading", { name: "Your first tenders are ready" })).toBeVisible({ timeout: 120_000 });
  await pause(page, 2200);
  await click(page, page.getByRole("button", { name: "Decide your first one" }), 2000);

  await say(page, "Your first decision", "Each screen explains itself on the first visit", 3600);
  await click(page, page.getByRole("button", { name: "Got it" }), 900);
  await hover(page, page.getByRole("heading", { name: "Suggested actions, one by one" }), 600);
  await scroll(page, -2000, 400);
  await say(page, "Fit score, reasons and risks, written by the assistant and labelled as a suggestion", undefined, 3000);
  await click(page, page.getByRole("button", { name: /^Approve all \(\d\)$/ }), 1400);
  await say(page, "Approve all: one decision for the whole notice", "Each action still runs on its own, and is recorded under your name", 2200);
  await click(page, page.getByRole("dialog").getByRole("button", { name: "Approve all", exact: true }), 2600);
  }

  /* ------------------------------------------------------------------ part 2: a working company */
  if (page.url() === "about:blank") await page.goto("/");
  await card(page, "A few days later", "Liffey Digital Ltd · five watchlists · a full pipeline", 3000);
  await page.goto("/sign-in");
  // A new session for the second account; the cursor and caption overlay keep their state in sessionStorage.
  await page.evaluate(() => sessionStorage.removeItem("tenderline.session"));
  await page.reload();
  await say(page, "Signing in to a company that has been using Tenderline for a while", undefined, 800);
  await type(page, page.getByLabel("Local account name"), OWNER);
  // Pretend the last visit was two hours ago, so "since you were last here" has something to say.
  await page.evaluate(() => {
    for (const id of ["today", "decide", "pipeline", "notices", "watchlists", "matched", "deadlines", "audit", "sources"])
      localStorage.setItem(`tenderline.tip.intro.${id}`, "1");
  });
  await click(page, page.getByRole("button", { name: "Sign in locally" }), 400);
  await page.waitForURL(/\/o\/[0-9a-f-]+$/);
  const orgId = page.url().match(/\/o\/([0-9a-f-]+)/)![1]!;
  await page.evaluate((org) => {
    localStorage.setItem(`tenderline.visit.${org}`, JSON.stringify({ previous: Date.now() - 26 * 3600_000, current: Date.now() - 2 * 3600_000 }));
  }, orgId);
  await page.reload();
  await expect(page.getByText("Do this next")).toBeVisible();

  await say(page, "Today: what needs you now", "One next step, what changed since your last visit, and your progress", 3600);
  await hover(page, page.getByText("Do this next"), 1800);
  await scroll(page, 520);
  await say(page, "Every chart explains itself on hover, and opens what it shows", undefined, 1200);
  const dots = page.getByRole("group", { name: /deadline/ }).locator("a");
  if (await dots.count()) await hover(page, dots.first(), 2200);
  await hover(page, page.getByRole("link", { name: "Bidding" }).first(), 1800);
  await scroll(page, 520);
  await hover(page, page.getByRole("group", { name: /Fit of/ }).locator("[tabindex='0']").last(), 2200);
  await scroll(page, -2000, 400);

  await say(page, "To decide: the assistant's suggestions, best fit first", undefined, 600);
  await click(page, page.getByRole("link", { name: /To decide/ }).first(), 1600);
  await click(page, page.getByRole("button", { name: /^Strong fit \d+$/ }), 1800);
  await say(page, "Filters: strong fit, closing soon, changed by the buyer", "Keyboard: j and k move between notices", 1600);
  await page.keyboard.press("j");
  await pause(page, 1300);
  await page.keyboard.press("j");
  await pause(page, 1600);
  await click(page, page.getByRole("group", { name: "Filter waiting notices" }).getByRole("button", { name: /^All \d+$/ }), 1200);

  // Open a notice that has a reminder suggestion, to show editing one.
  const withReminders = await page.evaluate(async (org) => {
    const session = JSON.parse(sessionStorage.getItem("tenderline.session") ?? "{}");
    const r = await fetch(`/v1/organisations/${org}/agent-proposals?status=pending&limit=200`, { headers: { Authorization: `Bearer ${session.token}` } });
    const items = (await r.json()).items as { notice_id: string; action_type: string; fit_score: number | null }[];
    const hit = items.filter((p) => p.action_type === "add_deadline_reminders").sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0))[0];
    return hit?.notice_id ?? null;
  }, orgId);
  if (withReminders) {
    await page.goto(`/o/${orgId}/approvals?notice=${withReminders}`);
    await pause(page, 1600);
  }
  const reminders = page.locator("li", { hasText: "Add deadline reminders" }).first();
  if (await reminders.count()) {
    await say(page, "Edit a suggestion before approving it", "The assistant's original stays in the audit log", 1000);
    await click(page, reminders.getByRole("button", { name: "Edit and approve" }), 1200);
    const edit = page.getByRole("dialog");
    await click(page, edit.getByRole("button", { name: /^Remove \d+ days$/ }).first(), 700);
    await type(page, edit.getByRole("spinbutton"), "21");
    await click(page, edit.getByRole("button", { name: "Add" }), 900);
    await click(page, edit.getByRole("button", { name: "Approve edited version" }), 2600);
  }
  await say(page, "Not interested? One reason rejects every suggestion for the notice", "Nothing is run", 800);
  await click(page, page.getByRole("button", { name: "Not for us" }), 1000);
  await type(page, page.getByRole("dialog").getByLabel("Why not?"), "Outside the regions we deliver in");
  await click(page, page.getByRole("dialog").getByRole("button", { name: "Reject all" }), 2400);

  await say(page, "Pipeline: every tender you track, from new to won", undefined, 600);
  await click(page, page.getByRole("link", { name: "Pipeline" }).first(), 2600);
  const newCard = page.getByRole("region", { name: /^New:/ }).getByRole("article").first();
  if (await newCard.count()) {
    await say(page, "Only valid moves are offered", "A refused move would slide back", 800);
    await click(page, newCard.getByRole("button", { name: /^Move / }), 1200);
    await click(page, page.getByRole("menuitem", { name: "Bidding" }), 2200);
  }
  await say(page, "Open a tender", undefined, 600);
  await click(page, page.getByRole("region", { name: /^Bidding:/ }).getByRole("article").first().getByRole("link"), 2400);
  await say(page, "What to do next, where it can move, and every deadline on a timeline", undefined, 3600);
  await scroll(page, 520);
  await say(page, "Add the deadlines to Outlook or Google Calendar", undefined, 600);
  const download = page.waitForEvent("download").catch(() => null);
  await click(page, page.getByRole("button", { name: "Add to calendar" }), 1800);
  await download;
  await click(page, page.getByRole("button", { name: "Reminders" }), 1200);
  await say(page, "Reminders count back from the submission deadline", undefined, 1600);
  await page.keyboard.press("Escape");
  await pause(page, 600);
  await scroll(page, 900);
  await say(page, "The full history of this tender", undefined, 2600);
  await scroll(page, -3000, 400);

  await say(page, "Deadlines across every tender, by week", undefined, 600);
  await click(page, page.getByRole("link", { name: /^Deadlines/ }).first(), 2400);
  const day = page.getByRole("region", { name: "Month view" }).locator("button:not([disabled])").first();
  if (await day.count()) await hover(page, day, 2200);

  await say(page, "Matched notices, grouped by watchlist", "Why each one matched", 600);
  await click(page, page.getByRole("link", { name: "Matched notices" }).first(), 2600);
  await scroll(page, 700);
  await scroll(page, -700);

  await say(page, "All notices: explore beyond your watchlists", undefined, 600);
  await click(page, page.getByRole("link", { name: "All notices" }).first(), 1600);
  await type(page, page.getByLabel("Words in title or summary"), "cloud");
  await page.keyboard.press("Enter");
  await pause(page, 1600);
  await say(page, "Hover a row for a preview", undefined, 400);
  await hover(page, page.getByRole("list").locator("li button").first(), 2600);
  await click(page, page.getByRole("list").locator("li button").first(), 2200);
  await say(page, "Key facts, categories and the link to the original notice", undefined, 2600);
  await page.keyboard.press("Escape");
  await pause(page, 900);
  if (CHANGED) {
    await page.goto(`/o/${orgId}/notices?notice=${CHANGED}`);
    await say(page, "When a buyer corrects a notice, every version is kept", "Old and new values side by side", 900);
    const history = page.getByRole("heading", { name: "Version history" });
    await history.scrollIntoViewIfNeeded();
    await pause(page, 3200);
    await page.keyboard.press("Escape");
    await pause(page, 700);
  }
  await page.goto(`/o/${orgId}/notices?cpv=72000000&country=IRL`);
  await say(page, "Like what you see? Turn the filters into a watchlist", undefined, 600);
  await click(page, page.getByRole("link", { name: "Watch for notices like these" }), 1600);
  await say(page, "It tells you roughly how many open notices would match", undefined, 2800);
  await click(page, page.getByRole("dialog").getByRole("button", { name: "Cancel" }), 1000);
  await scroll(page, 600);
  await say(page, "Your watchlists, with how much each one catches", undefined, 2600);
  await scroll(page, -1200);

  await say(page, "The audit log: every suggestion and decision, by whom and when", undefined, 600);
  await click(page, page.getByRole("link", { name: "Audit log" }).first(), 1400);
  await page.getByLabel("Who").selectOption("human");
  await pause(page, 1400);
  await type(page, page.getByLabel("Search the log"), "approved");
  await pause(page, 1200);
  await click(page, page.getByRole("button", { name: "Details" }).first(), 2600);

  await say(page, "Data sources: when notices were last collected", undefined, 600);
  await click(page, page.getByRole("link", { name: "Data sources" }).first(), 3000);

  await say(page, "Settings: the company profile the assistant reads, and your team", undefined, 600);
  await click(page, page.getByRole("link", { name: "Settings" }).first(), 3200);
  await scroll(page, 700);
  await say(page, "Light theme, for daytime", undefined, 400);
  await click(page, page.getByRole("button", { name: "light", exact: true }), 2200);
  await scroll(page, -1500);

  await click(page, page.getByRole("link", { name: "Today" }).first(), 1600);
  await say(page, "Ctrl + K: jump anywhere, search notices, run common actions", undefined, 500);
  await page.keyboard.press("Control+k");
  await pause(page, 1200);
  await page.keyboard.type("strong", { delay: 90 });
  await pause(page, 1800);
  await page.keyboard.press("Enter");
  await pause(page, 2200);
  await say(page, "Press ? for every keyboard shortcut", undefined, 400);
  await page.keyboard.press("?");
  await pause(page, 2600);
  await page.keyboard.press("Escape");
  await say(page, "", undefined, 300);

  await card(page, "📜 Tenderline", "The assistant suggests. You decide. Everything is recorded.", 4200);
  await context.close();
  const video = await page.video()?.path();
  console.log("VIDEO", video, "base", baseURL);
});
