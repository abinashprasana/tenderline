import type { AuditEntry, Deadline, Opportunity, Proposal } from "@/api/hooks";
import { plural } from "@/lib/labels";

export interface NextAction {
  kind: "deadline" | "strong" | "decide" | "changed" | "assessing" | "watchlist" | "clear";
  title: string;
  body: string;
  cta?: string;
  to?: "/o/$orgId/approvals" | "/o/$orgId/opportunities/$oppId" | "/o/$orgId/opportunities" | "/o/$orgId/searches" | "/o/$orgId/matches";
  oppId?: string;
  search?: { filter?: "strong" };
  /** For a deadline: when it falls due, so the card can count down. */
  due?: string;
}

const THREE_DAYS = 3 * 86_400_000;

/**
 * The single most useful thing to do now. Rules, in order:
 * 1. a deadline on a tracked tender within three days;
 * 2. strong-fit notices (70+) waiting for a decision;
 * 3. a tracked tender whose notice the buyer changed;
 * 4. any notices waiting for a decision;
 * 5. no watchlist yet;
 * 6. matched notices the assistant has not assessed yet;
 * otherwise everything is up to date.
 */
export function nextAction(input: {
  now: number;
  deadlines: Deadline[];
  pending: Proposal[];
  opportunities: Opportunity[];
  watchlists: number;
  assessing: number;
  titles: Map<string, string>;
}): NextAction {
  const { now, deadlines, pending, opportunities, watchlists, assessing, titles } = input;

  const open = new Set(opportunities.filter((o) => o.allowed_transitions.length > 0).map((o) => o.id));
  const soonest = deadlines
    .filter((d) => !d.fired_at && open.has(d.opportunity_id))
    .map((d) => ({ d, at: new Date(d.due_at).getTime() }))
    .filter(({ at }) => at >= now && at - now <= THREE_DAYS)
    .sort((a, b) => a.at - b.at)[0];
  if (soonest) {
    const what = soonest.d.kind === "submission" ? "The submission deadline" : soonest.d.kind === "reminder" ? "A reminder" : "A deadline";
    return {
      kind: "deadline",
      title: titles.get(soonest.d.opportunity_id) ?? "A tender you track",
      body: `${what} is close.`,
      cta: "Open the tender",
      to: "/o/$orgId/opportunities/$oppId",
      oppId: soonest.d.opportunity_id,
      due: soonest.d.due_at,
    };
  }

  const notices = new Map<string, number>();
  for (const p of pending) notices.set(p.notice_id, Math.max(notices.get(p.notice_id) ?? -1, p.fit_score ?? -1));
  const strong = [...notices.values()].filter((fit) => fit >= 70).length;
  if (strong > 0) {
    return {
      kind: "strong",
      title: `${plural(strong, "strong fit")} waiting for you`,
      body: "The assistant rates these 70 or higher for your company. Start with them.",
      cta: "Decide the strong fits",
      to: "/o/$orgId/approvals",
      search: { filter: "strong" },
    };
  }

  const changed = opportunities.find((o) => o.flags?.notice_changed && o.allowed_transitions.length > 0);
  if (changed) {
    return {
      kind: "changed",
      title: "A buyer changed a tender you track",
      body: `${changed.notice_title || "A tracked tender"} was corrected. Check what is different.`,
      cta: "See what changed",
      to: "/o/$orgId/opportunities/$oppId",
      oppId: changed.id,
    };
  }

  if (notices.size > 0) {
    return {
      kind: "decide",
      title: `${plural(notices.size, "notice")} waiting for your decision`,
      body: "None is a strong fit, but each needs a yes or a no.",
      cta: "Open To decide",
      to: "/o/$orgId/approvals",
    };
  }

  if (watchlists === 0) {
    return {
      kind: "watchlist",
      title: "Tell Tenderline what to watch for",
      body: "Without a watchlist no notices are brought to you.",
      cta: "Create a watchlist",
      to: "/o/$orgId/searches",
    };
  }

  if (assessing > 0) {
    return {
      kind: "assessing",
      title: `${plural(assessing, "matched notice")} not assessed yet`,
      body: "New matches are assessed as they arrive. Older ones from a watchlist's first sweep wait until you ask.",
      cta: "Review matched notices",
      to: "/o/$orgId/matches",
    };
  }

  return {
    kind: "clear",
    title: "You are up to date",
    body: "Nothing needs a decision and no deadline is close. New notices are checked every day.",
    cta: "Look at your pipeline",
    to: "/o/$orgId/opportunities",
  };
}

const NEWS: { match: (action: string) => boolean; one: string; many: string }[] = [
  { match: (a) => a === "match.qualified", one: "notice assessed by the assistant", many: "notices assessed by the assistant" },
  { match: (a) => a === "opportunity.flagged_changed", one: "tracked tender changed by its buyer", many: "tracked tenders changed by their buyers" },
  { match: (a) => a === "reminder.fired", one: "reminder came due", many: "reminders came due" },
  { match: (a) => a === "deadline.passed", one: "submission deadline passed", many: "submission deadlines passed" },
  { match: (a) => a === "opportunity.status_changed", one: "pipeline move", many: "pipeline moves" },
  { match: (a) => a === "proposal.approved" || a === "proposal.edited" || a === "proposal.rejected", one: "decision made", many: "decisions made" },
];

/** What happened since `since`, counted from the most recent audit entries (up to the page that was loaded). */
export function sinceLastVisit(entries: AuditEntry[], since: number): { label: string; count: number }[] {
  const fresh = entries.filter((entry) => new Date(entry.occurred_at).getTime() > since);
  return NEWS.map((kind) => {
    const count = fresh.filter((entry) => kind.match(entry.action)).length;
    return { label: count === 1 ? kind.one : kind.many, count };
  }).filter((item) => item.count > 0);
}
