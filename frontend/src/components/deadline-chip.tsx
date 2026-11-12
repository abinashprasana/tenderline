import { Clock } from "lucide-react";

import { cn } from "@/lib/cn";
import { countdown, fullDateTime, relative, urgency } from "@/lib/format";
import { useNow } from "@/lib/use-now";

import { Tooltip } from "./ui/states";

const TONE = {
  past: "text-faint bg-surface-2 border-hairline",
  critical: "text-lost bg-lost-soft border-lost/30",
  soon: "text-soon bg-soon-soft border-soon/30",
  later: "text-muted bg-surface-2 border-hairline",
  none: "text-faint bg-surface-2 border-hairline",
};

/** Time left until a deadline, counting down live. Red under 3 days, amber under 14. */
export function DeadlineChip({ at, className }: { at: string | null | undefined; className?: string }) {
  const now = useNow();
  const level = urgency(at, now);
  return (
    <Tooltip label={at ? `Closes ${fullDateTime(at)} (your local time)` : "The notice gives no deadline"}>
      <span
        tabIndex={0}
        className={cn(
          "tabular inline-flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-xs whitespace-nowrap",
          TONE[level],
          className,
        )}
      >
        <Clock className="size-3" aria-hidden />
        <span className="sr-only">Time left: </span>
        {countdown(at, now)}
      </span>
    </Tooltip>
  );
}

/** "5 minutes ago" that keeps itself current; the exact time is on hover. */
export function Ago({ at, className }: { at: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!at) return <span className={className}>never</span>;
  return (
    <time dateTime={at} title={fullDateTime(at)} className={className}>
      {relative(at, now)}
    </time>
  );
}

