import { Clock } from "lucide-react";

import { cn } from "@/lib/cn";
import { countdown, dateTime, urgency } from "@/lib/format";

import { Tooltip } from "./ui/states";

const TONE = {
  past: "text-faint bg-surface-2 border-hairline",
  critical: "text-lost bg-lost-soft border-lost/30",
  soon: "text-soon bg-soon-soft border-soon/30",
  later: "text-muted bg-surface-2 border-hairline",
  none: "text-faint bg-surface-2 border-hairline",
};

/** Time left until a deadline. Red under 3 days, amber under 14. */
export function DeadlineChip({ at, className }: { at: string | null | undefined; className?: string }) {
  const level = urgency(at);
  return (
    <Tooltip label={at ? `Deadline ${dateTime(at)}` : "The notice gives no deadline"}>
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
        {countdown(at)}
      </span>
    </Tooltip>
  );
}
