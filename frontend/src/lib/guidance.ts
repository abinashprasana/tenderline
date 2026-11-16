/**
 * Authored help for each screen, shown by the Tenderline Guide. One entry per section of the app; the
 * page introductions keep their own longer text, and their ? button opens this guide.
 */
export const GUIDE_EVENT = "tenderline:guide";

/** Opens the guide from anywhere, for example the ? button next to a page title. */
export function openGuide(): void {
  window.dispatchEvent(new Event(GUIDE_EVENT));
}

export type GuideRoute =
  | "/o/$orgId"
  | "/o/$orgId/approvals"
  | "/o/$orgId/opportunities"
  | "/o/$orgId/deadlines"
  | "/o/$orgId/notices"
  | "/o/$orgId/matches"
  | "/o/$orgId/searches"
  | "/o/$orgId/audit"
  | "/o/$orgId/ingestion"
  | "/o/$orgId/settings";

export interface Guidance {
  title: string;
  body: string;
  /** Two or three short tips, shown one at a time. */
  tips: string[];
  /** Up to three next steps that make sense from this screen. */
  links: { to: GuideRoute; label: string }[];
}

export type GuideSection =
  | "today"
  | "approvals"
  | "opportunities"
  | "opportunity"
  | "deadlines"
  | "notices"
  | "matches"
  | "searches"
  | "audit"
  | "ingestion"
  | "settings"
  | "welcome";

export const GUIDANCE: Record<GuideSection, Guidance> = {
  today: {
    title: "A little help with your day",
    body: "Start with the card marked Do this next. It picks the most useful thing to do now: a close deadline, a strong fit or a tender the buyer changed.",
    tips: ["The number next to To decide is how many notices wait for you.", "Press Ctrl+K to search notices or run an action from anywhere.", "Since your last visit shows what the assistant did while you were away."],
    links: [
      { to: "/o/$orgId/approvals", label: "Decide waiting notices" },
      { to: "/o/$orgId/deadlines", label: "Check upcoming deadlines" },
      { to: "/o/$orgId/opportunities", label: "Look at your pipeline" },
    ],
  },
  approvals: {
    title: "Make a confident decision",
    body: "Read the notice facts first, then the assistant's reasons and risks. Each suggested action runs only when you approve it. You can edit its details first, or say no with a reason.",
    tips: ["Press j and k to move between notices, a to approve, e to edit, r to reject.", "Strong fit means the assistant rates the notice 70 or higher for your company.", "Not for us declines every suggestion on a notice at once, with one reason."],
    links: [
      { to: "/o/$orgId/notices", label: "Search all notices" },
      { to: "/o/$orgId/opportunities", label: "Follow your tracked tenders" },
      { to: "/o/$orgId/audit", label: "See past decisions" },
    ],
  },
  opportunities: {
    title: "Keep your bids moving",
    body: "Each card is a tender you track. Use its Move menu to change stage, or drag it to another column. Open a card for its deadlines, reminders and history.",
    tips: ["Only moves that make sense are offered: New can go to Bidding or No bid.", "A tender the buyer corrected gets a badge, so you never miss a change.", "Open a card to add reminders or put its deadline in your calendar."],
    links: [
      { to: "/o/$orgId/deadlines", label: "Plan upcoming deadlines" },
      { to: "/o/$orgId/approvals", label: "Decide waiting notices" },
    ],
  },
  opportunity: {
    title: "Your tender, in one place",
    body: "Check the notice, its deadlines and what happened so far. If the buyer corrected the notice, the changes are shown before anything else. Move the stage from the header.",
    tips: ["Reminders are sent ahead of the deadline you pick.", "Add to calendar downloads the deadline for Outlook, Google or Apple Calendar.", "The history shows every decision and change on this tender."],
    links: [
      { to: "/o/$orgId/opportunities", label: "Back to the pipeline" },
      { to: "/o/$orgId/deadlines", label: "See all deadlines" },
    ],
  },
  deadlines: {
    title: "Plan around the next deadline",
    body: "The nearest dates come first, grouped by week. Pick a day on the heatmap to see only that day, or export the calendar to keep the dates next to your other work.",
    tips: ["Darker days on the heatmap have more deadlines.", "Export puts every upcoming date in your calendar in one file.", "Clarification deadlines often come before the submission date. Check both."],
    links: [
      { to: "/o/$orgId/opportunities", label: "Open your pipeline" },
      { to: "/o/$orgId", label: "Back to Today" },
    ],
  },
  notices: {
    title: "Find the right tenders",
    body: "Narrow the list by category, buyer, country or value. Every filter is kept in the address, so a search can be shared. Found a good set? Turn it into a watchlist.",
    tips: ["Hover a notice to preview it without leaving the list.", "Watch for notices like these turns your current filters into a watchlist.", "The address keeps your filters, so you can bookmark or share a search."],
    links: [
      { to: "/o/$orgId/searches", label: "Manage watchlists" },
      { to: "/o/$orgId/matches", label: "See matched notices" },
    ],
  },
  matches: {
    title: "Understand why it matched",
    body: "Each row says which watchlist caught the notice. A match without a fit score has not been assessed yet. You can ask for an assessment from here.",
    tips: ["Matches are grouped by the watchlist that caught them.", "Assess now asks the assistant to score matches that were skipped.", "A notice can match more than one watchlist."],
    links: [
      { to: "/o/$orgId/approvals", label: "Decide waiting notices" },
      { to: "/o/$orgId/searches", label: "Adjust your watchlists" },
    ],
  },
  searches: {
    title: "Tell Tenderline what to look for",
    body: "A notice matches when it meets every rule in a watchlist. Start broad with one category and your country, check the estimate, then narrow it if too much arrives.",
    tips: ["The estimate shows how many recent notices would have matched.", "Pausing a watchlist keeps its rules but stops new matches.", "Categories are CPV codes, the EU's standard list of what is being bought."],
    links: [
      { to: "/o/$orgId/notices", label: "Browse notices first" },
      { to: "/o/$orgId/matches", label: "See what matched" },
    ],
  },
  audit: {
    title: "Follow the decision trail",
    body: "Every suggestion, decision and change is recorded with who made it and when. Filter by person or by assistant, search the entries, and open one to see the details.",
    tips: ["Filter by Who to see only people, or only the assistant.", "Search finds entries by action, item or reason.", "Open Details to see exactly what changed."],
    links: [
      { to: "/o/$orgId/approvals", label: "Decide waiting notices" },
      { to: "/o/$orgId/settings", label: "Manage your team" },
    ],
  },
  ingestion: {
    title: "Check where notices come from",
    body: "See when notices were last collected and whether any run failed. TED is collected every day. eTenders data arrives through CSV imports.",
    tips: ["TED is the EU's official journal of public tenders.", "A failed run is retried. Check here if notices look out of date.", "Withdrawn notices are kept, with their status, so history stays complete."],
    links: [
      { to: "/o/$orgId/notices", label: "Search the notices" },
      { to: "/o/$orgId", label: "Back to Today" },
    ],
  },
  settings: {
    title: "Make Tenderline yours",
    body: "The company profile is what the assistant reads when it assesses a notice, so keep it current. Owners manage the team here. Display preferences stay in this browser.",
    tips: ["A sharper company description gives sharper fit scores.", "Reviewers can decide suggestions; viewers can only look.", "Theme, guide and tips settings stay in this browser."],
    links: [
      { to: "/o/$orgId/searches", label: "Review your watchlists" },
      { to: "/o/$orgId/audit", label: "See the audit log" },
    ],
  },
  welcome: {
    title: "Start with your company",
    body: "Describe your company and pick what to watch for. Tenderline then finds matching notices and prepares suggestions for your team to review.",
    tips: ["Pick one or two categories to start. You can add more later.", "Your first matches are assessed straight away.", "Nothing runs until someone on your team approves it."],
    links: [],
  },
};

/** Which guide entry belongs to a path such as `/o/123/approvals` or `/o/123/opportunities/456`. */
export function sectionFor(pathname: string): GuideSection {
  if (pathname.startsWith("/welcome")) return "welcome";
  const [, root, , section, detail] = pathname.split("/");
  if (root !== "o" || !section) return "today";
  if (section === "opportunities" && detail) return "opportunity";
  return section in GUIDANCE ? (section as GuideSection) : "today";
}

export interface GuideTask {
  label: string;
  /** Other words people might type for this task. */
  words: string;
  to: GuideRoute;
  /** Where to look once there. */
  where: string;
  /** The control Wren flies to and points out: an element marked `data-wren-target` on that screen. */
  target?: string;
}

/** What people come to Tenderline to do, for the guide's "What do you want to do?" finder. */
export const TASKS: GuideTask[] = [
  { label: "Decide waiting notices", words: "approve suggestion review pending inbox", to: "/o/$orgId/approvals", where: "Pick a notice, then approve, edit or reject each action.", target: "decide-list" },
  { label: "Approve every action on a notice", words: "approve all bulk accept", to: "/o/$orgId/approvals", where: "Open a notice with several actions and use Approve all.", target: "approve-all" },
  { label: "Say a notice is not for us", words: "reject decline skip ignore not interested", to: "/o/$orgId/approvals", where: "Open the notice and choose Not for us, with a reason." },
  { label: "Edit a suggestion before approving", words: "change modify adjust reminder days", to: "/o/$orgId/approvals", where: "Choose Edit on the action, change it, then approve." },
  { label: "Move a tender to another stage", words: "pipeline bid submitted won lost status kanban", to: "/o/$orgId/opportunities", where: "Use Move on a card, or drag it to another column.", target: "pipeline-board" },
  { label: "Add a reminder to a tender", words: "remind alert notify deadline", to: "/o/$orgId/opportunities", where: "Open the tender, then Reminders." },
  { label: "Put a deadline in my calendar", words: "calendar ics outlook google apple export", to: "/o/$orgId/deadlines", where: "Use Export here, or Add to calendar on a tender.", target: "export-calendar" },
  { label: "See what is due this week", words: "deadlines upcoming soon closing agenda", to: "/o/$orgId/deadlines", where: "The agenda is grouped by week, nearest first." },
  { label: "Search all notices", words: "find look browse tenders explore", to: "/o/$orgId/notices", where: "Type in the search box, then narrow with the filters.", target: "notice-search" },
  { label: "Create a watchlist", words: "saved search alert rules cpv keywords new", to: "/o/$orgId/searches", where: "Use New watchlist and check the estimate before saving.", target: "new-watchlist" },
  { label: "Turn a search into a watchlist", words: "watch for notices like these save filters", to: "/o/$orgId/notices", where: "Filter the notices, then Watch for notices like these.", target: "watch-these" },
  { label: "Pause or change a watchlist", words: "edit stop disable rules", to: "/o/$orgId/searches", where: "Open the watchlist's menu." },
  { label: "Ask for matches to be assessed", words: "assess now score unassessed fit", to: "/o/$orgId/matches", where: "Use Assess now above the matches.", target: "assess-now" },
  { label: "See why a notice matched", words: "matched reason watchlist caught", to: "/o/$orgId/matches", where: "Each match names the watchlist that caught it." },
  { label: "Find who approved something", words: "audit history log who when decision trail", to: "/o/$orgId/audit", where: "Search the audit log or filter by Who.", target: "audit-search" },
  { label: "Check when notices were collected", words: "data sources ted etenders ingestion stale import", to: "/o/$orgId/ingestion", where: "The last run and any failures are listed." },
  { label: "Invite a teammate", words: "member user add team role reviewer", to: "/o/$orgId/settings", where: "Owners add people under Team.", target: "team" },
  { label: "Improve the fit scores", words: "company profile description capabilities certifications", to: "/o/$orgId/settings", where: "Describe your company under Company profile.", target: "company-profile" },
  { label: "Switch between light and dark", words: "theme dark mode light mode colours appearance", to: "/o/$orgId/settings", where: "Under Your preferences, or the sun and moon button at the top." },
  { label: "See what to do next", words: "today home start overview dashboard", to: "/o/$orgId", where: "The Do this next card picks the most useful step.", target: "next-action" },
];

/** Tasks for what someone typed: every word must appear in the label or its other words. Best first. */
export function findTasks(query: string, limit = 5): GuideTask[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return TASKS.flatMap((task) => {
    const label = task.label.toLowerCase();
    const text = `${label} ${task.words}`;
    if (!words.every((w) => text.includes(w))) return [];
    // A word in the label counts more than one in the other words; a label starting with it most.
    const score = words.reduce((sum, w) => sum + (label.includes(w) ? 2 : 1), 0) + (label.startsWith(words[0]!) ? 2 : 0);
    return [{ task, score }];
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ task }) => task);
}
