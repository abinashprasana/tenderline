import { useEffect, useState } from "react";

import { Dialog } from "./ui/dialog";
import { Kbd } from "./ui/states";

const GROUPS: { title: string; rows: { keys: string[]; does: string }[] }[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: ["Ctrl", "K"], does: "Search notices or jump to a screen" },
      { keys: ["g", "t"], does: "Go to Today" },
      { keys: ["g", "d"], does: "Go to To decide" },
      { keys: ["g", "p"], does: "Go to Pipeline" },
      { keys: ["?"], does: "Show this list" },
    ],
  },
  {
    title: "To decide",
    rows: [
      { keys: ["j"], does: "Next notice" },
      { keys: ["k"], does: "Previous notice" },
      { keys: ["a"], does: "Approve the highlighted action" },
      { keys: ["e"], does: "Edit, then approve" },
      { keys: ["r"], does: "Reject with a reason" },
    ],
  },
];

/** True when a key press belongs to a text field, a dialog or a modifier chord, so shortcuts stay out of the way. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !!target?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")
  );
}

/**
 * The shortcut sheet, opened with "?" or from the account menu, plus the "g then letter" go-to keys.
 * `onGo` receives "t", "d" or "p".
 */
export function Shortcuts({ open, onOpenChange, onGo }: { open: boolean; onOpenChange: (open: boolean) => void; onGo: (key: string) => void }) {
  const [awaitingGo, setAwaitingGo] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      if (event.key === "?") {
        event.preventDefault();
        onOpenChange(true);
      } else if (awaitingGo) {
        setAwaitingGo(false);
        if ("tdp".includes(event.key)) onGo(event.key);
      } else if (event.key === "g") {
        setAwaitingGo(true);
        timer = window.setTimeout(() => setAwaitingGo(false), 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [awaitingGo, onGo, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="Everything also works with the mouse or touch.">
      <div className="grid gap-6 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-medium tracking-[0.06em] text-faint uppercase">{group.title}</h3>
            <dl className="flex flex-col gap-2">
              {group.rows.map((row) => (
                <div key={row.does} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-muted">{row.does}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {row.keys.map((key, index) => (
                      <span key={key} className="flex items-center gap-1">
                        {index > 0 ? <span className="text-xs text-faint">{row.keys[0] === "Ctrl" ? "+" : "then"}</span> : null}
                        <Kbd>{key}</Kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
