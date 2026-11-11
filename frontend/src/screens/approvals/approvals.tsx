import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Check, CheckCheck, ExternalLink, Inbox, Pencil, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ApiError, describeError } from "@/api/errors";
import {
  useApprove,
  useEditApprove,
  useMembers,
  useNotice,
  useProposal,
  useProposals,
  useReject,
  type Member,
  type Proposal,
} from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { DeadlineChip } from "@/components/deadline-chip";
import { FitRing } from "@/components/fit-ring";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, Kbd, PageHeader, SkeletonRows, Tooltip } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { ACTION_LABEL, dateTime, humanise, money, relative } from "@/lib/format";
import { NEED } from "@/lib/permissions";

import { PayloadForm, PayloadView, validatePayload, type Payload } from "./payload";

const EASE = [0.22, 1, 0.36, 1] as const;

interface NoticeGroup {
  noticeId: string;
  title: string;
  deadline: string | null | undefined;
  fit: number | null;
  proposals: Proposal[];
}

function groupByNotice(proposals: Proposal[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const proposal of proposals) {
    const group = groups.get(proposal.notice_id) ?? {
      noticeId: proposal.notice_id,
      title: proposal.notice_title,
      deadline: proposal.notice_deadline_at,
      fit: proposal.fit_score,
      proposals: [],
    };
    group.proposals.push(proposal);
    group.fit = Math.max(group.fit ?? -1, proposal.fit_score ?? -1);
    groups.set(proposal.notice_id, group);
  }
  const deadlineOf = (g: NoticeGroup) => (g.deadline ? new Date(g.deadline).getTime() : Infinity);
  return [...groups.values()].sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || deadlineOf(a) - deadlineOf(b));
}

export function Approvals() {
  const org = useOrg();
  const search = useSearch({ from: "/o/$orgId/approvals" });
  const navigate = useNavigate({ from: "/o/$orgId/approvals" });
  const decided = search.view === "decided";
  const pending = useProposals(org.id, { status: "pending" });
  const groups = useMemo(() => groupByNotice(pending.data?.items ?? []), [pending.data]);
  // The selection stays on the same notice while the list refreshes. When its last action is decided, the
  // notice that moved into its place is selected, like the next message in a mail client.
  const [pinned, setPinned] = useState<{ id?: string; index: number }>({ index: 0 });
  const wanted = search.notice ?? pinned.id;
  const selected = groups.find((g) => g.noticeId === wanted) ?? groups[Math.min(pinned.index, groups.length - 1)];
  const selectedIndex = selected ? groups.indexOf(selected) : 0;
  if (selected && (pinned.id !== selected.noticeId || pinned.index !== selectedIndex)) {
    setPinned({ id: selected.noticeId, index: selectedIndex });
  }
  const [running, setRunning] = useState<string[]>([]);
  const addRunning = useCallback((id: string) => setRunning((ids) => [...ids, id]), []);
  const removeRunning = useCallback((id: string) => setRunning((ids) => ids.filter((x) => x !== id)), []);

  // On narrow screens the list and the detail take turns; this says which one is showing.
  const [showList, setShowList] = useState(false);
  const select = (noticeId: string | undefined) => {
    setShowList(false);
    void navigate({ search: (prev) => ({ ...prev, notice: noticeId }), replace: true });
  };

  // j / k move between notices, like a mail client.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event) || decided || groups.length === 0) return;
      const index = groups.findIndex((g) => g.noticeId === selected?.noticeId);
      if (event.key === "j") select(groups[Math.min(index + 1, groups.length - 1)]?.noticeId);
      if (event.key === "k") select(groups[Math.max(index - 1, 0)]?.noticeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        description="The agent proposes; nothing happens until someone here approves it."
        actions={
          <div className="flex rounded-full border border-hairline bg-surface/60 p-0.5" role="tablist" aria-label="Show">
            {(["pending", "decided"] as const).map((view) => (
              <button
                key={view}
                role="tab"
                aria-selected={(view === "decided") === decided}
                onClick={() => void navigate({ search: { view: view === "decided" ? "decided" : undefined } })}
                className="h-8 rounded-full px-4 text-sm text-muted transition-colors aria-selected:bg-surface-3 aria-selected:text-text"
              >
                {view === "pending" ? `Waiting${pending.data ? ` (${pending.data.items.length})` : ""}` : "Decided"}
              </button>
            ))}
          </div>
        }
      />

      {decided ? (
        <DecidedList />
      ) : pending.isPending ? (
        <SkeletonRows rows={5} />
      ) : pending.isError ? (
        <ErrorState error={pending.error} onRetry={() => void pending.refetch()} />
      ) : groups.length === 0 && running.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<CheckCheck className="size-5" />}
            title="Nothing waiting for a decision"
            action={
              <Button asChild variant="secondary">
                <Link to="/o/$orgId/searches" params={{ orgId: org.id }}>
                  Review saved searches
                </Link>
              </Button>
            }
          >
            New proposals appear here when a notice matches one of your saved searches and the agent has assessed it.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(18rem,22rem)_1fr]">
          <nav aria-label="Notices waiting for a decision" className={cn("panel h-fit overflow-hidden lg:sticky lg:top-20", !showList && "max-lg:hidden")}>
            <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5 text-xs text-faint">
              <span>Best fit first</span>
              <span className="hidden items-center gap-1 lg:flex">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd> to move
              </span>
            </div>
            <ul className="max-h-[calc(100dvh-12rem)] overflow-y-auto p-1.5">
              {groups.map((group) => {
                const active = group.noticeId === selected?.noticeId;
                return (
                  <li key={group.noticeId}>
                    <button
                      onClick={() => select(group.noticeId)}
                      aria-current={active || undefined}
                      className={cn(
                        "relative flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors",
                        active ? "bg-accent-soft" : "hover:bg-surface-2",
                      )}
                    >
                      {active ? (
                        <motion.span layoutId="approval-active" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" transition={{ duration: 0.2, ease: EASE }} />
                      ) : null}
                      <FitRing score={group.fit} size={36} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-sm font-medium">{group.title || "Untitled notice"}</span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                          <DeadlineChip at={group.deadline} />
                          {group.proposals.length} {group.proposals.length === 1 ? "action" : "actions"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <section aria-live="polite" className={cn("min-w-0", showList && "max-lg:hidden")}>
            <RunningStrip ids={running} onDone={removeRunning} />
            {selected ? (
              <NoticeDecision
                key={selected.noticeId}
                group={selected}
                onBack={() => setShowList(true)}
                onDecided={addRunning}
              />
            ) : null}
          </section>
        </div>
      )}
    </>
  );
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !!target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")
  );
}

function NoticeDecision({ group, onBack, onDecided }: { group: NoticeGroup; onBack: () => void; onDecided: (id: string) => void }) {
  const org = useOrg();
  const notice = useNotice(group.noticeId);
  const members = useMembers(org.id);
  const assessment = group.proposals.find((p) => p.assessment)?.assessment;
  const canDecide = useCan("decide");
  const [active, setActive] = useState(group.proposals[0]?.id);
  const cards = useRef<Record<string, CardHandle | null>>({});

  // a / e / r act on the highlighted action card.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event) || !active || !canDecide) return;
      const card = cards.current[active];
      if (!card) return;
      if (event.key === "a") card.approve();
      if (event.key === "e") card.edit();
      if (event.key === "r") card.reject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canDecide]);

  const n = notice.data;
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col gap-4"
    >
      <div className="panel p-5">
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 lg:hidden" onClick={onBack}>
          <ArrowLeft className="size-4" /> All notices
        </Button>
        <div className="flex items-start gap-4">
          <FitRing score={group.fit} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg leading-snug font-semibold">{group.title || "Untitled notice"}</h2>
            <p className="mt-1 text-sm text-muted">
              {n ? (
                <>
                  {n.buyer_name ?? "Buyer not stated"} · {money(n.estimated_value, n.currency)} · {n.country ?? "—"}
                </>
              ) : (
                "Loading notice…"
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DeadlineChip at={group.deadline} />
              {n?.cpv_codes.slice(0, 4).map((code) => (
                <Badge key={code} className="font-mono">
                  {code}
                </Badge>
              ))}
              <Button asChild variant="ghost" size="sm">
                <Link to="/o/$orgId/notices" params={{ orgId: org.id }} search={{ notice: group.noticeId }}>
                  Notice details
                </Link>
              </Button>
              {n?.source_url ? (
                <Button asChild variant="ghost" size="sm">
                  <a href={n.source_url} target="_blank" rel="noreferrer noopener">
                    Source <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {assessment ? (
          <div className="mt-5 grid gap-4 border-t border-hairline pt-4 md:grid-cols-2">
            <AgentList title="Why it may fit" items={assessment.reasons} icon={<Check className="size-3.5 text-won" />} />
            <AgentList title="Risks" items={assessment.risks} icon={<AlertTriangle className="size-3.5 text-soon" />} />
          </div>
        ) : null}
      </div>

      <h3 className="px-1 text-sm font-medium text-muted">Proposed actions</h3>
      <motion.ul layout className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {group.proposals.map((proposal) => (
            <motion.li
              key={proposal.id}
              layout
              exit={{ opacity: 0, height: 0, marginBottom: -12, transition: { duration: 0.32, ease: EASE } }}
              onFocusCapture={() => setActive(proposal.id)}
              onMouseEnter={() => setActive(proposal.id)}
            >
              <ActionCard
                ref={(handle) => {
                  cards.current[proposal.id] = handle;
                }}
                proposal={proposal}
                members={members.data ?? []}
                deadline={group.deadline}
                highlighted={active === proposal.id}
                canDecide={canDecide}
                onDecided={onDecided}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
      {canDecide ? (
        <p className="hidden items-center gap-1.5 px-1 text-xs text-faint lg:flex">
          <Kbd>a</Kbd> approve <Kbd>e</Kbd> edit <Kbd>r</Kbd> reject the highlighted action
        </p>
      ) : null}
    </motion.article>
  );
}

function AgentList({ title, items, icon }: { title: string; items: string[]; icon: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        <AgentLabel />
      </div>
      {items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((item, index) => (
            <li key={index} className="flex gap-2 text-sm leading-snug text-muted">
              <span className="mt-0.5 shrink-0">{icon}</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">None given.</p>
      )}
    </div>
  );
}

/** Marks text the model wrote from public notice text. It is a suggestion, not a verified fact. */
export function AgentLabel() {
  return (
    <Tooltip label="Written by the AI agent from the public notice. Treat it as a suggestion and check the source.">
      <span tabIndex={0}>
        <Badge tone="agent" icon={<Sparkles className="size-3" />} className="h-5 px-2 text-[0.6875rem]">
          Agent suggestion
        </Badge>
      </span>
    </Tooltip>
  );
}

interface CardHandle {
  approve: () => void;
  edit: () => void;
  reject: () => void;
}

const ActionCard = forwardRef<
  CardHandle,
  {
    proposal: Proposal;
    members: Member[];
    deadline: string | null | undefined;
    highlighted: boolean;
    canDecide: boolean;
    onDecided: (id: string) => void;
  }
>(function ActionCard({ proposal, members, deadline, highlighted, canDecide, onDecided }, ref) {
  const org = useOrg();
  const approve = useApprove(org.id);
  const editApprove = useEditApprove(org.id);
  const reject = useReject(org.id);
  const [dialog, setDialog] = useState<"edit" | "reject" | null>(null);
  const [draft, setDraft] = useState<Payload>(proposal.payload);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const errors = validatePayload(proposal.action_type, draft);
  const serverErrors = editApprove.error instanceof ApiError && editApprove.error.code === "invalid_payload";
  const busy = approve.isPending || editApprove.isPending || reject.isPending;

  const doApprove = async () => {
    if (busy) return;
    await approve.mutateAsync({ id: proposal.id });
    onDecided(proposal.id);
  };
  useImperativeHandle(ref, () => ({
    approve: () => void doApprove().catch(() => {}),
    edit: () => setDialog("edit"),
    reject: () => setDialog("reject"),
  }));

  return (
    <div
      className={cn(
        "panel p-4 transition-[border-color,box-shadow] duration-200 sm:p-5",
        highlighted && "border-hairline-strong",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{ACTION_LABEL[proposal.action_type] ?? humanise(proposal.action_type)}</p>
          <p className="mt-0.5 text-xs text-faint">Proposed {relative(proposal.created_at)}</p>
        </div>
        <AgentLabel />
      </div>
      <div className="mt-3">
        <PayloadView action={proposal.action_type} payload={proposal.payload} members={members} deadline={deadline} />
      </div>
      {proposal.rationale ? (
        <p className="mt-3 border-l-2 border-hairline-strong pl-3 text-sm leading-relaxed text-muted">{proposal.rationale}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canDecide ? (
          <>
            <Button variant="primary" size="sm" pending={approve.isPending} disabled={busy} onClick={() => void doApprove().catch(() => {})}>
              <Check className="size-3.5" /> Approve
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setDialog("edit")}>
              <Pencil className="size-3.5" /> Edit and approve
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDialog("reject")}>
              <X className="size-3.5" /> Reject
            </Button>
          </>
        ) : (
          <p className="text-xs text-faint">{NEED.decide}</p>
        )}
      </div>

      <Dialog
        open={dialog === "edit"}
        onOpenChange={(open) => setDialog(open ? "edit" : null)}
        title={`Edit, then approve: ${ACTION_LABEL[proposal.action_type] ?? humanise(proposal.action_type)}`}
        description="Your version is what runs. The agent's original stays in the audit log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              pending={editApprove.isPending}
              disabled={Object.keys(errors).length > 0}
              onClick={async () => {
                await editApprove.mutateAsync({ id: proposal.id, payload: draft, comment });
                setDialog(null);
                onDecided(proposal.id);
              }}
            >
              Approve edited version
            </Button>
          </>
        }
      >
        <PayloadForm action={proposal.action_type} value={draft} onChange={setDraft} errors={errors} members={members} />
        {serverErrors ? <p className="mt-3 text-sm text-lost">{describeError(editApprove.error)}</p> : null}
        <Field label="Comment (optional)" className="mt-4">
          {(props) => <Textarea {...props} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} className="min-h-16" />}
        </Field>
      </Dialog>

      <Dialog
        open={dialog === "reject"}
        onOpenChange={(open) => setDialog(open ? "reject" : null)}
        title="Reject this action"
        description="The reason is recorded in the audit log and helps the team see why."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              pending={reject.isPending}
              disabled={reason.trim().length < 3}
              onClick={async () => {
                await reject.mutateAsync({ id: proposal.id, reason: reason.trim() });
                setDialog(null);
                toast("Rejected. Nothing was run.");
              }}
            >
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="At least 3 characters.">
          {(props) => <Textarea {...props} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />}
        </Field>
      </Dialog>
    </div>
  );
});

/** After approval the server runs the action in the background; this follows each one until it finishes. */
function RunningStrip({ ids, onDone }: { ids: string[]; onDone: (id: string) => void }) {
  if (ids.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {ids.map((id) => (
          <motion.li key={id} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <RunningItem id={id} onDone={onDone} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function RunningItem({ id, onDone }: { id: string; onDone: (id: string) => void }) {
  const org = useOrg();
  const proposal = useProposal(org.id, id);
  const status = proposal.data?.status;
  const label = proposal.data ? (ACTION_LABEL[proposal.data.action_type] ?? humanise(proposal.data.action_type)) : "Action";
  const result = proposal.data?.result;

  useEffect(() => {
    if (status !== "executed" && status !== "failed") return;
    // The toast id makes this idempotent if the effect runs twice.
    if (status === "executed") toast.success(`${label}: done`, { id: `run-${id}` });
    else toast.error(`${label} could not run. ${describeResult(result)}`, { id: `run-${id}` });
    const timer = window.setTimeout(() => onDone(id), 2500);
    return () => window.clearTimeout(timer);
  }, [status, label, id, onDone, result]);

  return (
    <div className="panel flex items-center gap-3 px-4 py-3 text-sm">
      <Badge tone={STATUS_TONE[status ?? "approved"] ?? "neutral"}>{humanise(status ?? "approved")}</Badge>
      <span className="flex-1 truncate">{label}</span>
      <span className="text-xs text-faint">{proposal.data?.decided_at ? `approved ${dateTime(proposal.data.decided_at)}` : ""}</span>
    </div>
  );
}

function describeResult(result: unknown): string {
  if (result && typeof result === "object" && "error" in result) return String((result as { error: unknown }).error);
  return "See the audit log for details.";
}

function DecidedList() {
  const org = useOrg();
  const all = useProposals(org.id, {});
  const items = (all.data?.items ?? []).filter((p) => p.status !== "pending");
  if (all.isPending) return <SkeletonRows rows={6} />;
  if (all.isError) return <ErrorState error={all.error} onRetry={() => void all.refetch()} />;
  if (items.length === 0)
    return (
      <div className="panel">
        <EmptyState icon={<Inbox className="size-5" />} title="No decisions yet">
          Approved and rejected proposals are listed here, with who decided and when.
        </EmptyState>
      </div>
    );
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="text-left text-xs text-faint">
          <tr className="border-b border-hairline">
            <th className="px-4 py-2.5 font-medium">Notice</th>
            <th className="px-4 py-2.5 font-medium">Action</th>
            <th className="px-4 py-2.5 font-medium">Outcome</th>
            <th className="px-4 py-2.5 font-medium">Decided</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className="border-b border-hairline last:border-0">
              <td className="max-w-[22rem] truncate px-4 py-3">{p.notice_title || "Untitled notice"}</td>
              <td className="px-4 py-3 text-muted">{ACTION_LABEL[p.action_type] ?? humanise(p.action_type)}</td>
              <td className="px-4 py-3">
                <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{humanise(p.status)}</Badge>
                {p.approval?.decision === "edited" ? <span className="ml-2 text-xs text-faint">edited</span> : null}
                {p.approval?.reason ? <p className="mt-1 text-xs text-faint">“{p.approval.reason}”</p> : null}
              </td>
              <td className="px-4 py-3 text-muted">{dateTime(p.decided_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
