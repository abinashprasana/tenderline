import { motion } from "motion/react";
import type { ReactNode } from "react";

/**
 * Small line drawings for empty states. They take the current text colour (use text-accent), draw
 * themselves once in about half a second, and hold still under reduced motion.
 */
const draw = {
  initial: { pathLength: 0, opacity: 0 },
  animate: { pathLength: 1, opacity: 1 },
};

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 96 72" className="h-20 w-28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

function Stroke({ d, delay = 0, soft }: { d: string; delay?: number; soft?: boolean }) {
  return <motion.path d={d} {...draw} strokeOpacity={soft ? 0.35 : 1} transition={{ duration: 0.56, delay, ease: [0.22, 1, 0.36, 1] }} />;
}

/** An empty tray with a tick: everything is decided. */
export function AllDone() {
  return (
    <Frame label="All decided">
      <Stroke d="M14 40 24 16h48l10 24v14a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" soft />
      <Stroke d="M14 40h20a14 14 0 0 0 28 0h20" delay={0.1} soft />
      <Stroke d="M36 28l9 9 16-18" delay={0.3} />
    </Frame>
  );
}

/** A radar sweep: something is watching on your behalf. */
export function Watching() {
  return (
    <Frame label="Watching for notices">
      <Stroke d="M48 60a26 26 0 1 1 26-26" soft />
      <Stroke d="M48 48a14 14 0 1 1 14-14" delay={0.1} soft />
      <Stroke d="M48 34l20-16" delay={0.25} />
      <Stroke d="M66 42a3 3 0 1 0 .1 0M30 22a2 2 0 1 0 .1 0" delay={0.4} />
    </Frame>
  );
}

/** Three columns with one card: an empty pipeline. */
export function EmptyBoard() {
  return (
    <Frame label="Empty pipeline">
      <Stroke d="M10 12h22v48H10zM37 12h22v48H37zM64 12h22v48H64z" soft />
      <Stroke d="M14 18h14v10H14z" delay={0.25} />
      <Stroke d="M30 23h6m-3-3 3 3-3 3" delay={0.4} />
    </Frame>
  );
}

/** A calendar page with one day marked. */
export function EmptyCalendar() {
  return (
    <Frame label="No deadlines">
      <Stroke d="M18 16h60a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4zM14 28h68M30 10v10M66 10v10" soft />
      <Stroke d="M56 40h10v10H56z" delay={0.3} />
    </Frame>
  );
}

/** A stack of documents with a magnifier. */
export function NoResults() {
  return (
    <Frame label="Nothing found">
      <Stroke d="M22 14h34l10 10v34H22zM56 14v10h10M30 34h22M30 42h16" soft />
      <Stroke d="M62 44a10 10 0 1 0 .1 0M70 60l8 8" delay={0.3} />
    </Frame>
  );
}

/** A scroll with lines: nothing recorded yet. */
export function EmptyLog() {
  return (
    <Frame label="Nothing recorded yet">
      <Stroke d="M26 12h44v40a8 8 0 0 0 8 8H34a8 8 0 0 1-8-8z" soft />
      <Stroke d="M36 24h24M36 34h24M36 44h14" delay={0.25} />
    </Frame>
  );
}
