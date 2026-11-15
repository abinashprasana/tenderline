import { describe, expect, it } from "vitest";

import type { AuditEntry, Deadline, Opportunity, Proposal } from "@/api/hooks";
import { previousVisit } from "@/lib/first-run";
import { dayHeading, greeting } from "@/lib/format";
import { buildCalendar } from "@/lib/ics";
import { fitBand, plural } from "@/lib/labels";

import { nextAction, sinceLastVisit } from "./today";

const at = (hour: number, minute = 0) => new Date(2026, 10, 12, hour, minute);
const NOW = Date.parse("2026-11-12T12:00:00Z");
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const proposal = (notice: string, fit: number): Proposal =>
  ({ id: `${notice}-${fit}`, notice_id: notice, notice_version: 1, fit_score: fit, action_type: "create_opportunity", status: "pending" }) as Proposal;
const opportunity = (id: string, over: Partial<Opportunity> = {}): Opportunity =>
  ({ id, notice_id: `n-${id}`, notice_title: `Tender ${id}`, status: "new", flags: {}, allowed_transitions: ["bid", "no_bid"], deadlines: [], pending_proposals: 0, ...over }) as Opportunity;
const deadline = (opp: string, days: number, kind = "submission"): Deadline =>
  ({ id: `${opp}-${days}`, opportunity_id: opp, kind, due_at: inDays(days), note: null, source: "notice", proposal_id: null, fired_at: null }) as Deadline;

const base = { now: NOW, deadlines: [], pending: [], opportunities: [], watchlists: 1, assessing: 0, titles: new Map<string, string>() };

describe("greeting", () => {
  it("follows the local time of day and is neutral at night", () => {
    expect(greeting(at(0, 30))).toBe("Welcome back");
    expect(greeting(at(4, 59))).toBe("Welcome back");
    expect(greeting(at(6))).toBe("Good morning");
    expect(greeting(at(13))).toBe("Good afternoon");
    expect(greeting(at(19))).toBe("Good evening");
    expect(greeting(at(23, 30))).toBe("Welcome back");
  });
});

describe("next best action", () => {
  it("puts a deadline within three days first", () => {
    const action = nextAction({
      ...base,
      deadlines: [deadline("a", 10), deadline("b", 2)],
      opportunities: [opportunity("a"), opportunity("b")],
      pending: [proposal("n1", 90)],
      titles: new Map([["b", "Tender b"]]),
    });
    expect(action).toMatchObject({ kind: "deadline", oppId: "b", title: "Tender b" });
  });

  it("ignores deadlines on tenders that are already closed", () => {
    const action = nextAction({ ...base, deadlines: [deadline("a", 1)], opportunities: [opportunity("a", { status: "won", allowed_transitions: [] })] });
    expect(action.kind).toBe("clear");
  });

  it("then strong fits, counted per notice", () => {
    const action = nextAction({ ...base, pending: [proposal("n1", 85), proposal("n1", 85), proposal("n2", 72), proposal("n3", 30)] });
    expect(action).toMatchObject({ kind: "strong", search: { filter: "strong" } });
    expect(action.title).toBe("2 strong fits waiting for you");
  });

  it("then a tracked tender the buyer changed, then anything waiting", () => {
    const changed = opportunity("c", { flags: { notice_changed: { fields: ["deadline_at"] } } });
    expect(nextAction({ ...base, opportunities: [changed], pending: [proposal("n1", 30)] }).kind).toBe("changed");
    expect(nextAction({ ...base, pending: [proposal("n1", 30)] })).toMatchObject({ kind: "decide", title: "1 notice waiting for your decision" });
  });

  it("asks for a watchlist, reports assessing, or says all clear", () => {
    expect(nextAction({ ...base, watchlists: 0 }).kind).toBe("watchlist");
    expect(nextAction({ ...base, assessing: 4 }).title).toBe("4 matched notices not assessed yet");
    expect(nextAction(base).kind).toBe("clear");
  });
});

describe("since the last visit", () => {
  const entry = (action: string, minutesAgo: number): AuditEntry =>
    ({ id: minutesAgo, action, occurred_at: new Date(NOW - minutesAgo * 60_000).toISOString() }) as AuditEntry;

  it("counts only what happened after the last visit, in words", () => {
    const entries = [entry("match.qualified", 5), entry("match.qualified", 10), entry("reminder.fired", 20), entry("match.qualified", 500), entry("proposal.created", 3)];
    expect(sinceLastVisit(entries, NOW - 60 * 60_000)).toEqual([
      { label: "notices assessed by the assistant", count: 2 },
      { label: "reminder came due", count: 1 },
    ]);
    expect(sinceLastVisit(entries, NOW)).toEqual([]);
  });

  it("remembers the previous sitting, not a reload", () => {
    localStorage.clear();
    expect(previousVisit("org", NOW)).toBeNull();
    expect(previousVisit("org", NOW + 5 * 60_000)).toBeNull(); // same sitting
    expect(previousVisit("org", NOW + 3 * 3600_000)).toBe(NOW + 5 * 60_000); // came back later
    expect(previousVisit("org", NOW + 3 * 3600_000 + 60_000)).toBe(NOW + 5 * 60_000); // reload keeps it
  });
});

describe("calendar export", () => {
  it("writes a valid event per deadline with an escaped title", () => {
    const text = buildCalendar([{ id: "d1", at: "2026-12-10T12:00:00Z", title: "Submission deadline: Cloud, hosting; phase 1", url: "https://ted.europa.eu/x" }], NOW);
    expect(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(text).toContain("UID:d1@tenderline");
    expect(text).toContain("DTSTART:20261210T120000Z");
    expect(text).toContain("DTEND:20261210T123000Z");
    expect(text).toContain("SUMMARY:Submission deadline: Cloud\\, hosting\\; phase 1");
    expect(text).toContain("BEGIN:VALARM");
    expect(text.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(text.split("\r\n").every((line) => line.length <= 75)).toBe(true);
  });
});

describe("labels", () => {
  it("bands the fit score and pluralises", () => {
    expect([fitBand(70), fitBand(69), fitBand(39), fitBand(null)]).toEqual(["strong", "possible", "weak", "unknown"]);
    expect(plural(1, "notice")).toBe("1 notice");
    expect(plural(3, "deadline or reminder", "deadlines and reminders")).toBe("3 deadlines and reminders");
  });

  it("names days relative to today", () => {
    const now = new Date(2026, 10, 12, 9).getTime();
    expect(dayHeading(new Date(2026, 10, 12, 23).toISOString(), now)).toBe("Today");
    expect(dayHeading(new Date(2026, 10, 11, 1).toISOString(), now)).toBe("Yesterday");
    expect(dayHeading(new Date(2026, 10, 13, 1).toISOString(), now)).toBe("Tomorrow");
  });
});
