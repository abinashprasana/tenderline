import { motion } from "motion/react";

import type { Deadline } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { date, dateTime, STATUS_LABEL } from "@/lib/format";

/* ------------------------------------------------------------------ status machine */
// Positions on a 3x2 grid, matching TRANSITIONS in src/tenderline/opportunities.py.
const NODES: Record<string, { x: number; y: number }> = {
  new: { x: 60, y: 40 },
  bid: { x: 200, y: 40 },
  submitted: { x: 340, y: 40 },
  no_bid: { x: 130, y: 120 },
  won: { x: 450, y: 10 },
  lost: { x: 450, y: 80 },
};
const EDGES: [string, string][] = [
  ["new", "bid"],
  ["new", "no_bid"],
  ["bid", "submitted"],
  ["bid", "no_bid"],
  ["no_bid", "bid"],
  ["submitted", "won"],
  ["submitted", "lost"],
];

/** Where this opportunity is, and where it can go next (the accent edges). */
export function StatusMachine({ current, allowed }: { current: string; allowed: string[] }) {
  const W = 60;
  const H = 26;
  return (
    <svg viewBox="0 0 510 150" className="w-full max-w-xl" role="img" aria-label={`Status: ${STATUS_LABEL[current]}. Can move to ${allowed.map((s) => STATUS_LABEL[s]).join(", ") || "nothing"}.`}>
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" fill="var(--hairline-strong)" />
        </marker>
        <marker id="arrow-live" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 8 4 0 8z" fill="var(--accent)" />
        </marker>
      </defs>
      {EDGES.map(([from, to]) => {
        const a = NODES[from]!;
        const b = NODES[to]!;
        const live = from === current && allowed.includes(to);
        const back = from === "no_bid" && to === "bid";
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const ox = (dx / len) * (W / 2 + 4);
        const oy = (dy / len) * (H / 2 + 4);
        const sx = a.x + ox;
        const sy = a.y + oy;
        const ex = b.x - ox;
        const ey = b.y - oy;
        const bend = back ? `Q ${(sx + ex) / 2 + 22} ${(sy + ey) / 2 + 4} ${ex} ${ey}` : `L ${ex} ${ey}`;
        return (
          <motion.path
            key={`${from}-${to}`}
            d={`M ${sx} ${sy} ${bend}`}
            fill="none"
            stroke={live ? "var(--accent)" : "var(--hairline-strong)"}
            strokeWidth={live ? 2 : 1.25}
            strokeDasharray={live ? "0" : "3 4"}
            markerEnd={live ? "url(#arrow-live)" : "url(#arrow)"}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
          />
        );
      })}
      {Object.entries(NODES).map(([status, { x, y }]) => {
        const isCurrent = status === current;
        const next = allowed.includes(status);
        return (
          <g key={status} transform={`translate(${x - W / 2} ${y - H / 2})`}>
            <rect
              width={W}
              height={H}
              rx={H / 2}
              fill={isCurrent ? "var(--accent)" : next ? "var(--accent-soft)" : "var(--surface-2)"}
              stroke={isCurrent || next ? "var(--accent)" : "var(--hairline-strong)"}
            />
            <text
              x={W / 2}
              y={H / 2 + 4}
              textAnchor="middle"
              fontSize="11"
              fontWeight={isCurrent ? 600 : 500}
              fill={isCurrent ? "var(--accent-fg)" : next ? "var(--text)" : "var(--muted)"}
            >
              {STATUS_LABEL[status]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ deadline strip */
const KIND_STYLE: Record<string, { label: string; className: string }> = {
  submission: { label: "Submission deadline", className: "bg-lost" },
  reminder: { label: "Reminder", className: "bg-soon" },
  clarification: { label: "Clarification", className: "bg-info" },
  custom: { label: "Custom", className: "bg-accent" },
};

/**
 * A time axis from a few days ago to just past the last deadline: every deadline is a marker, the submission
 * deadline is a tall bar, and a line marks today.
 */
export function DeadlineStrip({ deadlines, now }: { deadlines: Deadline[]; now: number }) {
  if (deadlines.length === 0) return null;
  const times = deadlines.map((d) => new Date(d.due_at).getTime());
  const start = Math.min(now - 3 * 86_400_000, ...times);
  const end = Math.max(now + 7 * 86_400_000, ...times) + 3 * 86_400_000;
  const pos = (t: number) => `${((t - start) / (end - start)) * 100}%`;
  const ticks: number[] = [];
  const step = Math.max(1, Math.ceil((end - start) / 86_400_000 / 8)) * 86_400_000;
  for (let t = Math.ceil(start / 86_400_000) * 86_400_000; t < end; t += step) ticks.push(t);

  return (
    <figure className="mt-2">
      <div className="relative h-20" role="img" aria-label={`Timeline of ${deadlines.length} deadlines`}>
        <div className="absolute inset-x-0 top-10 h-px bg-hairline-strong" />
        {ticks.map((t) => (
          <div key={t} className="absolute top-12 -translate-x-1/2 text-[0.6875rem] text-faint tabular" style={{ left: pos(t) }}>
            {date(new Date(t).toISOString(), { year: undefined })}
          </div>
        ))}
        <div className="absolute top-0 bottom-6 w-px bg-accent" style={{ left: pos(now) }}>
          <span className="absolute -top-0.5 left-1.5 text-[0.6875rem] font-medium text-accent">Today</span>
        </div>
        {deadlines.map((deadline, index) => {
          const style = KIND_STYLE[deadline.kind] ?? KIND_STYLE.custom!;
          const submission = deadline.kind === "submission";
          return (
            <motion.div
              key={deadline.id}
              title={`${style.label}: ${dateTime(deadline.due_at)}${deadline.note ? ` — ${deadline.note}` : ""}`}
              className={cn(
                "absolute -translate-x-1/2 rounded-full",
                style.className,
                submission ? "top-4 h-12 w-1.5" : "top-[2.15rem] size-2.5 ring-2 ring-surface",
                deadline.fired_at && "opacity-40",
              )}
              style={{ left: pos(new Date(deadline.due_at).getTime()) }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: deadline.fired_at ? 0.4 : 1, scale: 1 }}
              transition={{ duration: 0.32, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] }}
            />
          );
        })}
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-faint">
        {Object.entries(KIND_STYLE)
          .filter(([kind]) => deadlines.some((d) => d.kind === kind))
          .map(([kind, style]) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", style.className)} />
              {style.label}
            </span>
          ))}
      </figcaption>
    </figure>
  );
}
