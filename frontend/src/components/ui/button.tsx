import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-[0_1px_0_0_oklch(1_0_0/0.25)_inset]",
  secondary: "bg-surface-2 text-text border border-hairline hover:bg-surface-3 hover:border-hairline-strong",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  quiet: "text-text hover:bg-surface-2",
  danger: "bg-lost-soft text-lost border border-lost/30 hover:bg-lost/20",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[0.8125rem] gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-6 text-[0.9375rem] gap-2",
  icon: "h-9 w-9 justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
  pending?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", asChild, pending, className, disabled, children, ...props },
  ref,
) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      ref={ref}
      className={cn(
        "inline-flex shrink-0 select-none items-center rounded-full font-medium whitespace-nowrap",
        "transition-[background-color,border-color,color,transform] duration-150 ease-out-quint",
        "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {pending ? <Spinner /> : null}
          {children}
        </>
      )}
    </Component>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("size-3.5 animate-spin motion-reduce:animate-none", className)} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
