import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

/** Free-text tags: type and press Enter or comma. Backspace on an empty field removes the last tag. */
export function TagInput({
  value,
  onChange,
  placeholder,
  normalise = (text) => text.trim(),
  validate,
  id,
  ...aria
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  normalise?: (text: string) => string;
  validate?: (text: string) => boolean;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const commit = () => {
    const text = normalise(draft);
    if (!text) return;
    if (validate && !validate(text)) {
      setBad(true);
      return;
    }
    if (!value.includes(text)) onChange([...value, text]);
    setDraft("");
    setBad(false);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-[var(--radius-input)] border border-hairline bg-bg-deep/60 px-2 py-1",
        "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30",
        bad && "border-lost",
      )}
    >
      {value.map((tag) => (
        <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 pr-1 pl-2.5 text-xs">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="grid size-4 place-items-center rounded-full text-faint hover:text-text"
            aria-label={`Remove ${tag}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        {...aria}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setBad(false);
        }}
        onKeyDown={onKey}
        onBlur={commit}
        placeholder={value.length ? "" : placeholder}
        className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}
