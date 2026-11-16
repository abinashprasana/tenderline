import { Link } from "@tanstack/react-router";
import { animate, motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef } from "react";

import type { Deadline, Summary } from "@/api/hooks";
import { Tooltip } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { countdown, date, fullDateTime, STATUS_LABEL } from "@/lib/format";
import { plural } from "@/lib/labels";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Counts up the first time a value arrives; later updates (the summary refreshes every minute) just show the
 * new number. Writes straight to the DOM, so render stays pure. Under reduced motion it never animates.
 */
export function Ticker({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const counted = useRef(false);
  // Layout effect: the 0 is in place before the first paint, so the final number never flashes first.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduce || counted.current) {
      node.textContent = String(value);
      return;
    }
    counted.current = true;
    const controls = animate(0, value, { duration: 0.56, ease: EASE, onUpdate: (v) => (node.textContent = String(Math.round(v))) });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className="tabular">
      {value}
    </span>
  );
}

const STATUS_HINT: Record<string, string> = {
  new: "Tracked, not yet decided",
  bid: "You are preparing a response",
  submitted: "Waiting for the award",
  won: "Awarded to you",
  lost: "Awarded to someone else",
  no_bid: "You decided not to bid",
};

/** Tenders in the pipeline by status: open stages first, then outcomes. Each row opens the pipeline. */
export function PipelineBars({ byStatus, orgId }: { byStatus: Summary["opportunities_by_status"]; orgId: string }) {
  const order = ["new", "bid", "submitted", "won", "lost", "no_bid"];
  const max = Math.max(1, ...order.map((s) => byStatus[s] ?? 0));
  const colour: Record<string, string> = {
    new: "bg-info",
    bid: "bg-accent",
    submitted: "bg-soon",
    won: "bg-won",
    lost: "bg-lost",
    no_bid: "bg-faint",
  };
  return (
    <ul className="flex flex-1 flex-col justify-between gap-1" aria-label="Tenders in the pipeline by status">
      {order.map((status, index) => {
        const count = byStatus[status] ?? 0;
        return (
          <li key={status}>
            <Tooltip label={`${STATUS_HINT[status]}: ${count}`} side="left">
              <Link
                to="/o/$orgId/opportunities"
                params={{ orgId }}
                className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3 rounded-md px-1 py-1.5 text-sm transition-colors hover:bg-surface-2"
              >
                <span className="text-muted">{STATUS_LABEL[status]}</span>
                <span className="h-2.5 rounded-full bg-surface-2">
                  <motion.span
                    className={cn("block h-full rounded-full", colour[status])}
                    initial={{ width: 0 }}
                    animate={{ width: `${(count / max) * 100}%` }}
                    transition={{ duration: 0.56, delay: index * 0.05, ease: EASE }}
                  />
                </span>
                <span className="tabular text-right font-mono">{count}</span>
              </Link>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

/** Notices waiting for a decision per fit band of ten points. Hover or focus a bar for its count. */
export function FitHistogram({ buckets }: { buckets: Summary["fit_score_histogram"] }) {
  const max = Math.max(1, ...buckets.map((b) => b.notices));
  const total = buckets.reduce((sum, b) => sum + b.notices, 0);
  return (
    <figure className="flex flex-1 flex-col">
      <div className="flex min-h-36 flex-1 items-end gap-1.5" role="group" aria-label={`Fit of ${plural(total, "notice")} waiting for a decision`}>
        {buckets.map((bucket, index) => {
          const height = (bucket.notices / max) * 100;
          const band = bucket.lower >= 70 ? "bg-won" : bucket.lower >= 40 ? "bg-soon" : "bg-lost/80";
          const words = bucket.lower >= 70 ? "strong fit" : bucket.lower >= 40 ? "possible fit" : "weak fit";
          return (
            <Tooltip key={bucket.lower} label={`Fit ${bucket.lower} to ${bucket.upper} (${words}): ${plural(bucket.notices, "notice")}`}>
              <div tabIndex={0} className="group flex h-full flex-1 flex-col items-center justify-end gap-1 rounded-sm">
                {bucket.notices ? <span className="tabular font-mono text-[0.6875rem] text-muted">{bucket.notices}</span> : null}
                <motion.div
                  className={cn("w-full rounded-t-[4px] transition-[filter] group-hover:brightness-125", bucket.notices ? band : "bg-surface-2")}
                  initial={{ height: 0 }}
                  animate={{ height: bucket.notices ? `${Math.max(height, 4)}%` : "2px" }}
                  transition={{ duration: 0.56, delay: index * 0.03, ease: EASE }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      <figcaption className="mt-2 flex justify-between text-[0.6875rem] text-muted">
        <span>Weak</span>
        <span>Possible</span>
        <span>Strong</span>
      </figcaption>
    </figure>
  );
}

const KIND_WORD: Record<string, string> = { submission: "Submission deadline", reminder: "Reminder", clarification: "Clarification deadline", custom: "Milestone" };

/** The next 30 days as a strip: one dot per deadline. Each dot opens its tender. */
export function DeadlineRiver({
  deadlines,
  now,
  orgId,
  titles,
  days = 30,
}: {
  deadlines: Deadline[];
  now: number;
  orgId: string;
  titles: Map<string, string>;
  days?: number;
}) {
  const end = now + days * 86_400_000;
  const upcoming = deadlines.filter((d) => {
    const t = new Date(d.due_at).getTime();
    return t >= now && t <= end;
  });
  const left = (iso: string) => `${((new Date(iso).getTime() - now) / (end - now)) * 100}%`;
  const weeks = [0, 7, 14, 21, 28].filter((d) => d <= days);
  // Stack dots that land on the same day.
  const lanes = new Map<string, number>();
  return (
    <figure>
      <div className="relative h-24" role="group" aria-label={`${plural(upcoming.length, "deadline")} in the next ${days} days`}>
        <div className="absolute inset-x-0 bottom-6 h-px bg-hairline-strong" />
        {weeks.map((d) => (
          <div key={d} className="absolute bottom-0 -translate-x-1/2 text-[0.6875rem] text-muted first:translate-x-0" style={{ left: `${(d / days) * 100}%` }}>
            {d === 0 ? "Today" : date(new Date(now + d * 86_400_000).toISOString(), { year: undefined })}
          </div>
        ))}
        <div className="absolute top-0 bottom-6 left-0 w-px bg-accent" />
        {upcoming.map((d, index) => {
          const day = d.due_at.slice(0, 10);
          const lane = lanes.get(day) ?? 0;
          lanes.set(day, lane + 1);
          const submission = d.kind === "submission";
          const label = `${KIND_WORD[d.kind] ?? "Deadline"}: ${titles.get(d.opportunity_id) ?? "a tracked tender"}. ${fullDateTime(d.due_at)}`;
          return (
            <Tooltip key={d.id} label={label}>
              <motion.span
                className="absolute -translate-x-1/2"
                style={{ left: left(d.due_at), bottom: `${1.75 + lane * 0.9}rem` }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32, delay: Math.min(index, 20) * 0.025, ease: EASE }}
              >
                <Link
                  to="/o/$orgId/opportunities/$oppId"
                  params={{ orgId, oppId: d.opportunity_id }}
                  aria-label={label}
                  className={cn(
                    "block size-3 rounded-full ring-2 ring-surface transition-transform hover:scale-150 focus-visible:scale-150",
                    submission ? "bg-lost" : d.kind === "reminder" ? "bg-soon" : "bg-info",
                  )}
                />
              </motion.span>
            </Tooltip>
          );
        })}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-lost" /> Submission deadline
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-soon" /> Reminder
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-info" /> Other
        </span>
      </figcaption>
    </figure>
  );
}

/** Waiting notices grouped into the three fit bands the histogram colours, as plain numbers. */
export function FitBands({ buckets, orgId }: { buckets: Summary["fit_score_histogram"]; orgId: string }) {
  const count = (from: number, to: number) => buckets.filter((b) => b.lower >= from && b.lower < to).reduce((sum, b) => sum + b.notices, 0);
  const bands = [
    { label: "Strong", range: "70 and up", notices: count(70, 101), dot: "bg-won" },
    { label: "Possible", range: "40 to 69", notices: count(40, 70), dot: "bg-soon" },
    { label: "Weak", range: "under 40", notices: count(0, 40), dot: "bg-lost/80" },
  ];
  const strong = bands[0]?.notices ?? 0;
  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <dl className="grid grid-cols-3 gap-2">
        {bands.map((band) => (
          <div key={band.label} className="rounded-lg bg-surface-2/60 px-3 py-2">
            <dt className="flex items-center gap-1.5 text-xs text-muted">
              <span className={cn("size-2 rounded-full", band.dot)} />
              {band.label}
            </dt>
            <dd className="tabular mt-1 font-mono text-lg leading-none">{band.notices}</dd>
            <dd className="mt-1 text-[0.6875rem] text-muted">{band.range}</dd>
          </div>
        ))}
      </dl>
      {strong ? (
        <Link to="/o/$orgId/approvals" params={{ orgId }} search={{ filter: "strong" }} className="mt-3 inline-flex text-sm text-accent underline-offset-4 hover:underline">
          Review the {plural(strong, "strong fit")} first
        </Link>
      ) : null}
    </div>
  );
}

/** The next few dated items, nearest first, so the strip above has names attached. */
export function NextDeadlines({
  deadlines,
  now,
  orgId,
  titles,
  count = 3,
}: {
  deadlines: Deadline[];
  now: number;
  orgId: string;
  titles: Map<string, string>;
  count?: number;
}) {
  const next = deadlines
    .filter((d) => new Date(d.due_at).getTime() >= now)
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .slice(0, count);
  if (!next.length) return null;
  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <h3 className="text-xs font-medium text-muted">Coming up first</h3>
      <ul className="mt-1.5 flex flex-col">
        {next.map((d) => (
          <li key={d.id}>
            <Link
              to="/o/$orgId/opportunities/$oppId"
              params={{ orgId, oppId: d.opportunity_id }}
              className="-mx-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-surface-2"
            >
              <span className={cn("size-2 rounded-full", d.kind === "submission" ? "bg-lost" : d.kind === "reminder" ? "bg-soon" : "bg-info")} />
              <span className="min-w-0">
                <span className="block truncate">{titles.get(d.opportunity_id) ?? "A tracked tender"}</span>
                <span className="block text-xs text-muted">
                  {KIND_WORD[d.kind] ?? "Deadline"}, {date(d.due_at, { year: undefined })}
                </span>
              </span>
              <span className={cn("tabular font-mono text-xs", d.kind === "submission" ? "text-soon" : "text-muted")}>{countdown(d.due_at, now)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
