/**
 * Every name a person sees, in one place. Routes and API fields keep their technical names
 * (approvals, saved-searches, ingestion); the interface uses these plainer words.
 */
export const SCREEN = {
  today: "Today",
  decide: "To decide",
  pipeline: "Pipeline",
  deadlines: "Deadlines",
  matched: "Matched notices",
  notices: "All notices",
  watchlists: "Watchlists",
  audit: "Audit log",
  sources: "Data sources",
  settings: "Settings",
} as const;

export const RUN_STATUS: Record<string, string> = {
  ok: "Completed",
  running: "Running now",
  error: "Failed",
  abandoned: "Interrupted",
};

export const NOTICE_STATUS: Record<string, string> = {
  open: "Open",
  awarded: "Awarded",
  cancelled: "Cancelled",
};

export const PROPOSAL_STATUS: Record<string, string> = {
  pending: "Waiting for you",
  approved: "Approved, running",
  executed: "Done",
  rejected: "Rejected",
  cancelled: "Withdrawn",
  failed: "Could not run",
};

/** One-line explanations for words a newcomer may not know. Used by <Term>. */
export const GLOSSARY = {
  cpv: "CPV is the EU's standard list of what is being bought. A broad code (72, IT services) covers every narrower code under it.",
  fit: "How well the assistant thinks this notice suits your company, from 0 to 100. 70 and above is a strong fit, 40 to 69 is possible, below 40 is weak. It is a suggestion, not a verdict.",
  watchlist: "A set of rules (categories, keywords, buyers, value) that Tenderline checks every new notice against.",
  changed: "The buyer published a correction to this notice. Tenderline keeps every version and shows what changed.",
  reminder: "A date before the submission deadline when Tenderline flags the tender for your team.",
  assistant: "The AI agent that reads matched notices and suggests actions. It cannot do anything until a person approves.",
  ted: "Tenders Electronic Daily, the EU's official journal of public procurement notices.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

export type FitBand = "strong" | "possible" | "weak" | "unknown";

export function fitBand(score: number | null | undefined): FitBand {
  if (typeof score !== "number") return "unknown";
  return score >= 70 ? "strong" : score >= 40 ? "possible" : "weak";
}

export const FIT_LABEL: Record<FitBand, string> = {
  strong: "Strong fit",
  possible: "Possible fit",
  weak: "Weak fit",
  unknown: "Not scored",
};

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
