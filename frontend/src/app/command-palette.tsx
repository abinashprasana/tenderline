import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { FileText, Inbox, Moon, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useDeferredValue, useState } from "react";

import { api, unwrap } from "@/api/client";
import { useProposals } from "@/api/hooks";
import { countdown } from "@/lib/format";
import { setTheme, useTheme } from "@/lib/theme";

import { useOrg } from "./org";
import { NAV } from "./shell";

const ITEM =
  "flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-muted outline-none " +
  "data-[selected=true]:bg-accent-soft data-[selected=true]:text-text";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const org = useOrg();
  const navigate = useNavigate();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const term = useDeferredValue(query.trim());

  const notices = useQuery({
    queryKey: ["palette-notices", term],
    enabled: open && term.length >= 3,
    queryFn: () => unwrap(api.GET("/v1/notices", { params: { query: { q: term, limit: 6 } } })),
    staleTime: 30_000,
  });
  const pending = useProposals(org.id, { status: "pending" });
  const awaiting = new Map<string, { title: string; count: number }>();
  for (const proposal of pending.data?.items ?? []) {
    const entry = awaiting.get(proposal.notice_id) ?? { title: proposal.notice_title, count: 0 };
    entry.count += 1;
    awaiting.set(proposal.notice_id, entry);
  }

  const go = (run: () => void) => {
    onOpenChange(false);
    setQuery("");
    run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-[oklch(0.1_0.02_230/0.45)]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.div
                className="glass fixed top-[12dvh] left-1/2 z-50 w-[min(calc(100vw-1.5rem),40rem)] overflow-hidden rounded-2xl"
                style={{ x: "-50%" }}
                initial={{ opacity: 0, scale: 0.97, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <Dialog.Title className="sr-only">Command palette</Dialog.Title>
                <Command label="Command palette" shouldFilter={term.length < 3}>
                  <div className="flex items-center gap-3 border-b border-hairline px-4">
                    <Search className="size-4 text-faint" aria-hidden />
                    <Command.Input
                      value={query}
                      onValueChange={setQuery}
                      placeholder="Type a page, or 3+ letters to search notices"
                      className="h-13 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-faint"
                    />
                  </div>
                  <Command.List className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2">
                    <Command.Empty className="px-3 py-8 text-center text-sm text-faint">
                      {notices.isFetching ? "Searching…" : "Nothing found."}
                    </Command.Empty>

                    {term.length >= 3 && notices.data?.items.length ? (
                      <Command.Group heading="Notices" className="palette-group">
                        {notices.data.items.map((notice) => (
                          <Command.Item
                            key={notice.id}
                            value={`notice ${notice.id} ${notice.title}`}
                            className={ITEM}
                            onSelect={() =>
                              go(() =>
                                void navigate({
                                  to: "/o/$orgId/notices",
                                  params: { orgId: org.id },
                                  search: { notice: notice.id },
                                }),
                              )
                            }
                          >
                            <FileText className="size-4 shrink-0" aria-hidden />
                            <span className="flex-1 truncate text-text">{notice.title}</span>
                            <span className="tabular font-mono text-xs text-faint">{countdown(notice.deadline_at)}</span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    ) : null}

                    {awaiting.size > 0 ? (
                      <Command.Group heading="Waiting for a decision" className="palette-group">
                        {[...awaiting.entries()].slice(0, 6).map(([noticeId, entry]) => (
                          <Command.Item
                            key={noticeId}
                            value={`approve ${entry.title}`}
                            className={ITEM}
                            onSelect={() =>
                              go(() =>
                                void navigate({
                                  to: "/o/$orgId/approvals",
                                  params: { orgId: org.id },
                                  search: { notice: noticeId },
                                }),
                              )
                            }
                          >
                            <Inbox className="size-4 shrink-0" aria-hidden />
                            <span className="flex-1 truncate text-text">{entry.title || "Untitled notice"}</span>
                            <span className="text-xs text-faint">
                              {entry.count} {entry.count === 1 ? "action" : "actions"}
                            </span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    ) : null}

                    <Command.Group heading="Go to" className="palette-group">
                      {NAV.flatMap((section) => section.items).map((item) => (
                        <Command.Item
                          key={item.to}
                          value={`go ${item.label}`}
                          className={ITEM}
                          onSelect={() => go(() => void navigate({ to: item.to, params: { orgId: org.id } }))}
                        >
                          <item.icon className="size-4 shrink-0" aria-hidden />
                          <span className="text-text">{item.label}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>

                    <Command.Group heading="Preferences" className="palette-group">
                      <Command.Item
                        value="theme toggle dark light"
                        className={ITEM}
                        onSelect={() => go(() => setTheme(theme === "dark" ? "light" : "dark"))}
                      >
                        <Moon className="size-4 shrink-0" aria-hidden />
                        <span className="text-text">Switch to {theme === "dark" ? "light" : "dark"} theme</span>
                      </Command.Item>
                    </Command.Group>
                  </Command.List>
                </Command>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
