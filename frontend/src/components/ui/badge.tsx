import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type Tone = "neutral" | "accent" | "won" | "lost" | "soon" | "info" | "agent";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-hairline",
  accent: "bg-accent-soft text-accent border-accent/25",
  won: "bg-won-soft text-won border-won/25",
  lost: "bg-lost-soft text-lost border-lost/25",
  soon: "bg-soon-soft text-soon border-soon/30",
  info: "bg-info-soft text-info border-info/25",
  agent: "bg-agent-soft text-agent border-agent/25",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  new: "info",
  bid: "accent",
  no_bid: "neutral",
  submitted: "soon",
  won: "won",
  lost: "lost",
  pending: "soon",
  approved: "accent",
  executed: "won",
  rejected: "lost",
  cancelled: "neutral",
  failed: "lost",
  ok: "won",
  abandoned: "neutral",
  running: "info",
  error: "lost",
};
