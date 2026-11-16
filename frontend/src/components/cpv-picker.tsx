import { Check, Search, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useDeferredValue, useId, useState } from "react";

import { useCpvSearch } from "@/api/hooks";
import { cn } from "@/lib/cn";

/** The English label for one CPV code, from the official CPV 2008 list the API serves. */
export function useCpvLabel(code: string): string | null {
  const result = useCpvSearch(code.replace(/0+$/, "") || code);
  return result.data?.find((item) => item.code === code)?.description ?? null;
}

export function CpvChip({ code, onRemove }: { code: string; onRemove?: () => void }) {
  const label = useCpvLabel(code);
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-hairline bg-surface-2 pr-1 pl-3 text-xs" title={label ?? undefined}>
      <span className="tabular font-mono text-muted">{code}</span>
      {label ? <span className="truncate">{label}</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="grid size-5 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-text"
          aria-label={`Remove ${code}`}
        >
          <X className="size-3" />
        </button>
      ) : (
        <span className="w-2" />
      )}
    </span>
  );
}

/**
 * Pick CPV codes by number ("72" finds every IT service) or by words ("cyber security"). A broad code also
 * covers everything under it, which is how saved searches match.
 */
export function CpvPicker({
  value,
  onChange,
  multiple = true,
  label = "CPV codes",
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  multiple?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const term = useDeferredValue(query.trim());
  const results = useCpvSearch(term, term === "");
  const listId = useId();

  const toggle = (code: string) => {
    if (value.includes(code)) onChange(value.filter((c) => c !== code));
    else onChange(multiple ? [...value, code] : [code]);
    if (!multiple) setOpen(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((code) => (
            <CpvChip key={code} code={code} onRemove={() => onChange(value.filter((c) => c !== code))} />
          ))}
        </div>
      ) : null}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-[var(--radius-input)] border border-hairline bg-bg-deep/60 px-3 text-left text-sm text-faint hover:border-hairline-strong"
          >
            <Search className="size-4" aria-hidden />
            <span className="sr-only">{label}: </span>
            {value.length ? "Add another code" : "Search by number or words"}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="glass glass-strong z-[60] w-[min(calc(100vw-2rem),28rem)] rounded-xl p-2"
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="72, 48000000, software, cleaning…"
              className="h-9 w-full rounded-lg border border-hairline bg-bg-deep/60 px-3 text-sm outline-none focus:border-accent"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-label="Search CPV codes"
            />
            <p className="px-1 pt-2 pb-1 text-[0.6875rem] text-faint">{term ? "Results" : "Top-level divisions"}</p>
            <ul id={listId} role="listbox" aria-multiselectable={multiple} className="max-h-72 overflow-y-auto">
              {(results.data ?? []).map((item) => {
                const selected = value.includes(item.code);
                return (
                  <li key={item.code} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onClick={() => toggle(item.code)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-3",
                        selected && "bg-accent-soft",
                      )}
                    >
                      <span className="tabular mt-0.5 font-mono text-xs text-muted">{item.code}</span>
                      <span className="flex-1 leading-snug">{item.description}</span>
                      {selected ? <Check className="mt-0.5 size-4 text-accent" /> : null}
                    </button>
                  </li>
                );
              })}
              {results.data && results.data.length === 0 ? (
                <li className="px-2 py-6 text-center text-sm text-faint">No codes match. Try fewer words.</li>
              ) : null}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
