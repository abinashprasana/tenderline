import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

const CONTROL =
  "w-full rounded-[var(--radius-input)] border border-hairline bg-bg-deep/60 px-3 text-sm text-text " +
  "placeholder:text-faint transition-[border-color,box-shadow] duration-150 " +
  "hover:border-hairline-strong focus-visible:border-accent focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent/30 aria-invalid:border-lost disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(CONTROL, "h-9", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(CONTROL, "h-9 appearance-none bg-no-repeat pr-8", className)} {...props}>
      {children}
    </select>
  );
});

/** Label, control, hint and error wired together with ids so screen readers announce them. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-muted">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy || undefined, "aria-invalid": error ? true : undefined })}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-lost" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
