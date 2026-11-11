import { animate, motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef } from "react";

import type { Deadline, Summary } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { date, dateTime, STATUS_LABEL } from "@/lib/format";

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

/** Opportunities by status, as a horizontal funnel: open stages first, then outcomes. */
export function PipelineBars({ byStatus }: { byStatus: Summary["opportunities_by_status"] }) {
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
    <ul className="flex flex-col gap-2.5" aria-label="Opportunities by status">
      {order.map((status, index) => {
        const count = byStatus[status] ?? 0;
        return (
          <li key={status} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3 text-sm">
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
          </li>
        );
      })}
    </ul>
  );
}

/** Pending proposals per fit-score band, one bar per 10 points. Bars are labelled directly. */
export function FitHistogram({ buckets }: { buckets: Summary["fit_score_histogram"] }) {
  const max = Math.max(1, ...buckets.map((b) => b.notices));
  const total = buckets.reduce((sum, b) => sum + b.notices, 0);
  return (
    <figure>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`Fit scores of ${total} notices waiting for a decision`}>
        {buckets.map((bucket, index) => {
          const height = (bucket.notices / max) * 100;
          const band = bucket.lower >= 70 ? "bg-won" : bucket.lower >= 40 ? "bg-soon" : "bg-lost/80";
          return (
            <div key={bucket.lower} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              {bucket.notices ? <span className="tabular font-mono text-[0.6875rem] text-muted">{bucket.notices}</span> : null}
              <motion.div
                className={cn("w-full rounded-t-[4px]", bucket.notices ? band : "bg-surface-2")}
                initial={{ height: 0 }}
                animate={{ height: bucket.notices ? `${Math.max(height, 4)}%` : "2px" }}
                transition={{ duration: 0.56, delay: index * 0.03, ease: EASE }}
                title={`${bucket.lower}–${bucket.upper}: ${bucket.notices}`}
              />
            </div>
          );
        })}
      </div>
      <figcaption className="mt-2 flex justify-between font-mono text-[0.6875rem] text-faint">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </figcaption>
    </figure>
  );
}

/** The next 30 days as a strip: one dot per deadline, red for submissions, amber for reminders. */
export function DeadlineRiver({ deadlines, now, days = 30 }: { deadlines: Deadline[]; now: number; days?: number }) {
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
      <div className="relative h-24" role="img" aria-label={`${upcoming.length} deadlines in the next ${days} days`}>
        <div className="absolute inset-x-0 bottom-6 h-px bg-hairline-strong" />
        {weeks.map((d) => (
          <div key={d} className="absolute bottom-0 -translate-x-1/2 text-[0.6875rem] text-faint" style={{ left: `${(d / days) * 100}%` }}>
            {d === 0 ? "Today" : date(new Date(now + d * 86_400_000).toISOString(), { year: undefined })}
          </div>
        ))}
        <div className="absolute top-0 bottom-6 left-0 w-px bg-accent" />
        {upcoming.map((d, index) => {
          const day = d.due_at.slice(0, 10);
          const lane = lanes.get(day) ?? 0;
          lanes.set(day, lane + 1);
          const submission = d.kind === "submission";
          return (
            <motion.span
              key={d.id}
              title={`${submission ? "Submission deadline" : d.kind === "reminder" ? "Reminder" : "Deadline"}: ${dateTime(d.due_at)}`}
              className={cn(
                "absolute size-3 -translate-x-1/2 rounded-full ring-2 ring-surface",
                submission ? "bg-lost" : d.kind === "reminder" ? "bg-soon" : "bg-info",
              )}
              style={{ left: left(d.due_at), bottom: `${1.75 + lane * 0.9}rem` }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, delay: Math.min(index, 20) * 0.025, ease: EASE }}
            />
          );
        })}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-lost" /> Submission
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
