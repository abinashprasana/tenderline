const LOCALE = "en-IE";

/** Money arrives from the API as a decimal string. It is formatted, never parsed to a float for display. */
export function money(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "Not stated";
  const [whole = "0"] = amount.split(".");
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 0,
    }).format(BigInt(whole));
  } catch {
    return `${currency ?? ""} ${whole}`.trim();
  }
}

/** Compact money for charts and chips: €1.2m, €450k. Uses the integer part only. */
export function moneyShort(amount: string | null | undefined, currency: string | null | undefined): string {
  if (!amount) return "—";
  const whole = Number(amount.split(".")[0]);
  if (!Number.isFinite(whole)) return money(amount, currency);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: currency || "EUR",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(whole);
}

export function date(value: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", ...opts }).format(
    new Date(value),
  );
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const seconds = (new Date(value).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export type Urgency = "past" | "critical" | "soon" | "later" | "none";

/** How close a deadline is: under 3 days is critical, under 14 is soon. */
export function urgency(value: string | null | undefined, now = Date.now()): Urgency {
  if (!value) return "none";
  const days = (new Date(value).getTime() - now) / 86_400_000;
  if (days < 0) return "past";
  if (days < 3) return "critical";
  if (days < 14) return "soon";
  return "later";
}

/** "3d 4h", "5h 12m", "closed". */
export function countdown(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "No deadline";
  const ms = new Date(value).getTime() - now;
  if (ms <= 0) return "Closed";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}

/**
 * A greeting for the local time of day. Late night and the small hours get a neutral greeting:
 * "Good morning" at half past midnight is wrong, and "Good night" is a goodbye.
 */
export function greeting(now: number | Date = Date.now()): string {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Welcome back";
}

/** Full date and time with the timezone name, for tooltips: "Thu 10 Dec 2026, 12:00 GMT". */
export function fullDateTime(value: string | null | undefined): string {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** "Today", "Yesterday", or the date: used as day headings. */
export function dayHeading(value: string, now = Date.now()): string {
  const day = new Date(value);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(new Date(now)) - start(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff === -1) return "Tomorrow";
  return new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long" }).format(day);
}

export function number(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** "add_deadline_reminders" -> "Add deadline reminders". */
export function humanise(value: string): string {
  const text = value.replace(/[_.]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const STATUS_LABEL: Record<string, string> = {
  new: "New",
  bid: "Bidding",
  no_bid: "No bid",
  submitted: "Submitted",
  won: "Won",
  lost: "Lost",
};

export const ACTION_LABEL: Record<string, string> = {
  create_opportunity: "Track in the pipeline",
  add_deadline_reminders: "Add deadline reminders",
  assign_reviewer: "Assign a reviewer",
  draft_clarification_question: "Draft a clarification question",
  mark_no_bid: "Mark as no bid",
};
