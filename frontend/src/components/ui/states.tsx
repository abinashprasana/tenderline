import { AlertTriangle, CircleHelp, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Tooltip as Primitive } from "radix-ui";

import { describeError } from "@/api/errors";
import { cn } from "@/lib/cn";
import { useDismissed } from "@/lib/first-run";

import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn("h-12", index % 3 === 2 && "w-4/5")} />
      ))}
    </div>
  );
}

/** Empty states say what to do next, not just that there is nothing here. */
export function EmptyState({
  icon,
  illustration,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  /** A small drawing from components/illustrations.tsx; takes the place of the icon. */
  illustration?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      {illustration ? (
        <div className="text-accent">{illustration}</div>
      ) : icon ? (
        <div className="grid size-11 place-items-center rounded-full border border-hairline bg-surface-2 text-muted">
          {icon}
        </div>
      ) : null}
      <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", className)}
    >
      <div className="grid size-11 place-items-center rounded-full bg-lost-soft text-lost">
        <AlertTriangle className="size-5" />
      </div>
      <p className="max-w-sm text-sm text-muted">{describeError(error)}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw className="size-3.5" /> Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Tooltip({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className="z-[70] max-w-64 rounded-md border border-hairline bg-surface-3 px-2.5 py-1.5 text-xs text-text shadow-lg"
        >
          {label}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-5 min-w-5 place-items-center rounded border border-hairline bg-surface-2 px-1 font-mono text-[0.6875rem] text-muted">
      {children}
    </kbd>
  );
}

export interface Intro {
  /** Remembered per screen, so each introduction is shown once and can be reopened with the ? button. */
  id: string;
  text: ReactNode;
  points?: { icon: ReactNode; title: string; body: ReactNode }[];
}

/**
 * Page title, one-line description and actions. With `intro`, a slim band below explains how the screen
 * works the first time someone visits; the ? button brings it back. Help in place, not a tour.
 */
export function PageHeader({
  title,
  description,
  actions,
  intro,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  intro?: Intro;
}) {
  const [dismissed, setDismissed] = useDismissed(`intro.${intro?.id ?? "none"}`);
  const open = Boolean(intro) && !dismissed;
  return (
    <header className="pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[1.375rem] font-semibold tracking-[-0.01em]">
            {title}
            {intro ? (
              <Tooltip label={open ? "Hide the introduction" : "How does this screen work?"}>
                <button
                  type="button"
                  onClick={() => setDismissed(open)}
                  aria-expanded={open}
                  aria-label="How this screen works"
                  className={cn(
                    "grid size-6 place-items-center rounded-full border border-hairline text-faint transition-colors hover:border-hairline-strong hover:text-text",
                    open && "border-accent/40 bg-accent-soft text-accent",
                  )}
                >
                  <CircleHelp className="size-3.5" />
                </button>
              </Tooltip>
            ) : null}
          </h1>
          {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <AnimatePresence initial={false}>
        {open && intro ? (
          <motion.section
            key="intro"
            aria-label="How this screen works"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 rounded-[var(--radius-panel)] border border-accent/25 bg-accent-soft p-4">
              <div className="flex items-start justify-between gap-4">
                <p className="max-w-3xl text-sm leading-relaxed">{intro.text}</p>
                <Button size="sm" variant="ghost" className="-mt-1 -mr-2 shrink-0" onClick={() => setDismissed(true)}>
                  Got it
                </Button>
              </div>
              {intro.points?.length ? (
                <ul className="mt-3 grid gap-3 sm:grid-cols-3">
                  {intro.points.map((point) => (
                    <li key={point.title} className="flex gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-accent">{point.icon}</span>
                      <span>
                        <span className="block text-sm font-medium">{point.title}</span>
                        <span className="block text-[0.8125rem] leading-snug text-muted">{point.body}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
