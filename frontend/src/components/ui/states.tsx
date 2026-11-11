import { AlertTriangle, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip as Primitive } from "radix-ui";

import { describeError } from "@/api/errors";
import { cn } from "@/lib/cn";

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
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      {icon ? (
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

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
