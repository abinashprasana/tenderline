import { Link } from "@tanstack/react-router";
import { ExternalLink, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

import { useNotice, useNoticeVersions, useOpportunities, useTrackNotice } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { CpvChip } from "@/components/cpv-picker";
import { DeadlineChip } from "@/components/deadline-chip";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { date, dateTime, humanise, money } from "@/lib/format";
import { rememberNotice } from "@/lib/first-run";
import { NOTICE_STATUS } from "@/lib/labels";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Notice details in a sheet that slides in from the right; the list stays where it was underneath. */
export function NoticeDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  return (
    <Dialog.Root open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
      <AnimatePresence>
        {id ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-40 bg-[oklch(0.1_0.02_230/0.4)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                className="glass fixed inset-y-2 right-2 z-50 flex w-[min(calc(100vw-1rem),40rem)] flex-col overflow-hidden rounded-2xl focus:outline-none"
                initial={{ x: "104%" }}
                animate={{ x: 0 }}
                exit={{ x: "104%" }}
                transition={{ duration: 0.32, ease: EASE }}
              >
                <DrawerBody id={id} />
              </motion.aside>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function DrawerBody({ id }: { id: string }) {
  const org = useOrg();
  const notice = useNotice(id);
  const versions = useNoticeVersions(id);
  const opportunities = useOpportunities(org.id);
  const track = useTrackNotice(org.id);
  const canWrite = useCan("write");
  const tracked = opportunities.data?.items.find((o) => o.notice_id === id);
  const n = notice.data;
  useEffect(() => {
    if (n) rememberNotice(n.id, n.title);
  }, [n]);

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
        <Dialog.Title className="text-base leading-snug font-semibold">{n?.title ?? "Notice"}</Dialog.Title>
        <Dialog.Close asChild>
          <Button variant="ghost" size="icon" aria-label="Close">
            <X className="size-4" />
          </Button>
        </Dialog.Close>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {notice.isPending ? (
          <SkeletonRows rows={5} />
        ) : notice.isError ? (
          <ErrorState error={notice.error} onRetry={() => void notice.refetch()} />
        ) : n ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[n.status] ?? "neutral"}>{NOTICE_STATUS[n.status] ?? humanise(n.status)}</Badge>
              <DeadlineChip at={n.deadline_at} />
              <Badge>{n.source === "ted" ? "TED" : n.source === "etenders" ? "eTenders" : n.source}</Badge>
              {tracked ? (
                <Button asChild size="sm" variant="ghost">
                  <Link to="/o/$orgId/opportunities/$oppId" params={{ orgId: org.id, oppId: tracked.id }}>
                    In your pipeline: open it
                  </Link>
                </Button>
              ) : canWrite ? (
                <Button
                  size="sm"
                  variant="primary"
                  pending={track.isPending}
                  onClick={() => track.mutate({ noticeId: n.id }, { onSuccess: () => toast.success("Tracking. It is now in your pipeline, with its deadline.") })}
                >
                  <Plus className="size-3.5" /> Track this notice
                </Button>
              ) : null}
            </div>

            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2.5 text-sm">
              <Fact label="Buyer">{n.buyer_name ?? "Not stated"}</Fact>
              <Fact label="Estimated value">{money(n.estimated_value, n.currency)}</Fact>
              <Fact label="Deadline">{dateTime(n.deadline_at)}</Fact>
              <Fact label="Published">{date(n.publication_date)}</Fact>
              <Fact label="Country">{n.country ?? "—"}</Fact>
              <Fact label="Notice type">{humanise(n.notice_type)}</Fact>
              <Fact label="Reference">
                <span className="font-mono text-xs">{n.source_id}</span>
              </Fact>
            </dl>

            {n.summary ? (
              <section>
                <h3 className="mb-1.5 text-sm font-medium text-muted">Summary from the notice</h3>
                <p className="text-sm leading-relaxed whitespace-pre-line">{n.summary}</p>
              </section>
            ) : null}

            {n.cpv_codes.length ? (
              <section>
                <h3 className="mb-2 text-sm font-medium text-muted">What is being bought: categories (CPV)</h3>
                <div className="flex flex-col items-start gap-1.5">
                  {n.cpv_codes.map((code) => (
                    <CpvChip key={code} code={code} />
                  ))}
                </div>
              </section>
            ) : null}

            {n.source_url ? (
              <Button asChild variant="secondary" className="w-fit">
                <a href={n.source_url} target="_blank" rel="noreferrer noopener">
                  Read the full notice at the source <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ) : null}

            <section>
              <h3 className="mb-2 text-sm font-medium text-muted">Version history</h3>
              {versions.data && versions.data.length > 0 ? (
                <ol className="relative flex flex-col gap-4 border-l border-hairline pl-5">
                  {versions.data.map((version, index) => (
                    <motion.li
                      key={version.version}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: index * 0.05, ease: EASE }}
                      className="relative"
                    >
                      <span className="absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden />
                      <p className="text-sm font-medium">
                        Version {version.version}{" "}
                        <span className="font-normal text-faint">· collected {dateTime(version.fetched_at)}</span>
                      </p>
                      {version.changes && Object.keys(version.changes).length ? (
                        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                          {Object.entries(version.changes as Record<string, { old?: unknown; new?: unknown }>).map(([field, diff]) => (
                            <div key={field} className="contents">
                              <dt className="text-muted">{humanise(field)}</dt>
                              <dd className="min-w-0 font-mono break-words">
                                <span className="text-lost line-through decoration-lost/40">{show(diff?.old)}</span>
                                {" → "}
                                <span className="text-won">{show(diff?.new)}</span>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="mt-0.5 text-xs text-faint">{index === 0 ? "First version seen." : "No tracked fields changed."}</p>
                      )}
                    </motion.li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-faint">Loading…</p>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return JSON.stringify(value);
}
