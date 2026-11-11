import { cn } from "@/lib/cn";

/** A T drawn as a tender line ending in a decision point. */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-surface-3" />
        <path d="M7 11h18M16 11v13" className="stroke-accent" strokeWidth="3" strokeLinecap="round" fill="none" />
        <circle cx="24" cy="22" r="2.5" className="fill-accent" />
      </svg>
      {compact ? null : <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">Tenderline</span>}
    </span>
  );
}
