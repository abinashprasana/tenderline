import { Link, useParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ArrowRight, BellPlus, CalendarDays, CalendarPlus, Copy, ExternalLink, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  useAddDeadline,
  useAddReminders,
  useAudit,
  useDeleteDeadline,
  useMembers,
  useNotice,
  useOpportunity,
  useSetStatus,
  type Deadline,
} from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { AuditTimeline } from "@/components/audit-timeline";
import { DeadlineChip } from "@/components/deadline-chip";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { dateTime, humanise, money, STATUS_LABEL } from "@/lib/format";
import { downloadCalendar } from "@/lib/ics";
import { useNow } from "@/lib/use-now";

import { DeadlineStrip, StatusMachine } from "./diagrams";

interface Flags {
  notice_changed?: { fields?: string[]; changes?: Record<string, { old: unknown; new: unknown }>; at?: string };
  outcome_needs_review?: boolean;
  clarification_drafts?: { proposal_id: string; question: string; status: string }[];
}

export function OpportunityDetail() {
  const org = useOrg();
  const { oppId } = useParams({ from: "/o/$orgId/opportunities/$oppId" });
  const opportunity = useOpportunity(org.id, oppId);
  const notice = useNotice(opportunity.data?.notice_id);
  const members = useMembers(org.id);
  const audit = useAudit(org.id, { entity_type: "opportunity", entity_id: oppId }, 30);
  const canWrite = useCan("write");
  const setStatus = useSetStatus(org.id);
  const [dialog, setDialog] = useState<"deadline" | "reminders" | null>(null);
  const now = useNow();

  if (opportunity.isPending) return <SkeletonRows rows={6} />;
  if (opportunity.isError) return <ErrorState error={opportunity.error} onRetry={() => void opportunity.refetch()} />;
  const o = opportunity.data;
  const flags = (o.flags ?? {}) as Flags;
  const n = notice.data;
  const reviewer = members.data?.find((m) => m.user_id === o.assigned_reviewer_id);

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/o/$orgId/opportunities" params={{ orgId: org.id }}>
          <ArrowLeft className="size-4" /> Back to pipeline
        </Link>
      </Button>

      <header className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{STATUS_LABEL[o.status] ?? o.status}</Badge>
            <h1 className="mt-2 text-xl leading-snug font-semibold tracking-[-0.01em]">{o.notice_title || "Untitled notice"}</h1>
            <p className="mt-1 text-sm text-muted">
              {n ? `${n.buyer_name ?? "Buyer not stated"} · ${money(n.estimated_value, n.currency)}` : " "}
              {reviewer ? ` · Reviewer: ${reviewer.name ?? reviewer.login}` : ""}
            </p>
            <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-sm">
              <ArrowRight className="size-3.5 text-accent" aria-hidden />
              <span className="sr-only">What to do next: </span>
              {nextStep(o.status, o.deadlines)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/o/$orgId/notices" params={{ orgId: org.id }} search={{ notice: o.notice_id }}>
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

        {flags.notice_changed ? <ChangedBanner change={flags.notice_changed} /> : null}
        {flags.outcome_needs_review ? (
          <Banner>
            An award notice was published, but the winner's name did not exactly match your organisation, so this was
            recorded as lost. Check the award notice, and move it to Won if it was you.
          </Banner>
        ) : null}

        <div className="mt-5 grid gap-6 border-t border-hairline pt-5 lg:grid-cols-[1fr_auto]">
          <div>
            <h2 className="mb-2 text-sm font-medium text-muted">Status</h2>
            <StatusMachine current={o.status} allowed={o.allowed_transitions} />
          </div>
          {canWrite && o.allowed_transitions.length ? (
            <div className="flex flex-col gap-2 lg:w-48">
              <h2 className="text-sm font-medium text-muted">Move to</h2>
              {o.allowed_transitions.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  pending={setStatus.isPending && setStatus.variables?.status === status}
                  disabled={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate(
                      { id: o.id, status },
                      { onSuccess: () => toast.success(`Moved to ${STATUS_LABEL[status]}`) },
                    )
                  }
                >
                  {STATUS_LABEL[status]}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <section className="panel p-5" aria-labelledby="deadlines-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="deadlines-title" className="font-medium">
            Deadlines and reminders
          </h2>
          {canWrite ? (
            <div className="flex gap-2">
              {o.deadlines.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    downloadCalendar(
                      "tenderline-deadlines.ics",
                      o.deadlines
                        .filter((d) => !d.fired_at)
                        .map((d) => ({
                          id: d.id,
                          at: d.due_at,
                          title: `${d.kind === "submission" ? "Submission deadline" : humanise(d.kind)}: ${o.notice_title}`,
                          description: d.note ?? undefined,
                          url: n?.source_url ?? undefined,
                        })),
                    );
                    toast.success("Calendar file downloaded. Open it to add the dates to your calendar.");
                  }}
                >
                  <CalendarDays className="size-3.5" /> Add to calendar
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setDialog("reminders")}>
                <BellPlus className="size-3.5" /> Reminders
              </Button>
              <Button size="sm" onClick={() => setDialog("deadline")}>
                <CalendarPlus className="size-3.5" /> Deadline
              </Button>
            </div>
          ) : null}
        </div>
        {o.deadlines.length ? (
          <>
            <DeadlineStrip deadlines={o.deadlines} now={now} />
            <DeadlineList deadlines={o.deadlines} canWrite={canWrite} />
          </>
        ) : (
          <EmptyState title="No deadlines">The notice did not give a submission deadline. Add your own to get reminders.</EmptyState>
        )}
      </section>

      {flags.clarification_drafts?.length ? (
        <section className="panel p-5">
          <h2 className="font-medium">Clarification drafts</h2>
          <p className="mt-1 text-sm text-muted">
            Drafts only. Tenderline never contacts buyers; send questions through the tender's own channel.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {flags.clarification_drafts.map((draft) => (
              <li key={draft.proposal_id} className="rounded-lg border-l-2 border-agent bg-agent-soft px-3 py-2.5">
                <p className="text-sm leading-relaxed">{draft.question}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 -ml-2"
                  onClick={() => navigator.clipboard.writeText(draft.question).then(() => toast.success("Question copied"))}
                >
                  <Copy className="size-3.5" /> Copy
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel p-5">
        <h2 className="font-medium">History</h2>
        {audit.isPending ? (
          <SkeletonRows rows={3} className="mt-3" />
        ) : (
          <AuditTimeline entries={audit.data?.pages.flatMap((p) => p.items) ?? []} members={members.data ?? []} />
        )}
      </section>

      <AddDeadlineDialog open={dialog === "deadline"} onClose={() => setDialog(null)} oppId={o.id} />
      <RemindersDialog
        open={dialog === "reminders"}
        onClose={() => setDialog(null)}
        oppId={o.id}
        hasSubmission={o.deadlines.some((d) => d.kind === "submission")}
      />
    </div>
  );
}

/** One plain sentence on what this tender needs from you now. */
function nextStep(status: string, deadlines: Deadline[]): string {
  const hasReminder = deadlines.some((d) => d.kind === "reminder" && !d.fired_at);
  switch (status) {
    case "new":
      return "Decide whether to bid. Move it to Bidding or No bid.";
    case "bid":
      return hasReminder ? "Prepare your response. Move it to Submitted once it is sent." : "Add reminders so the deadline does not surprise you.";
    case "submitted":
      return "Nothing to do. Tenderline records the result when the award is published.";
    case "won":
      return "Awarded to you. Nothing more to do here.";
    case "lost":
      return "Awarded to someone else. Nothing more to do here.";
    default:
      return "You passed on this one. Move it back to Bidding if that changes.";
  }
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="mt-4 flex gap-3 rounded-lg border border-soon/30 bg-soon-soft px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-soon" />
      <div>{children}</div>
    </div>
  );
}

function ChangedBanner({ change }: { change: NonNullable<Flags["notice_changed"]> }) {
  return (
    <Banner>
      <p>
        The buyer changed this notice{change.at ? ` on ${dateTime(change.at)}` : ""}. Check what is different before you
        continue.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {Object.entries(change.changes ?? {}).map(([field, diff]) => (
          <div key={field} className="contents">
            <dt className="text-muted">{humanise(field)}</dt>
            <dd className="font-mono">
              <span className="text-lost line-through">{String(diff.old ?? "—")}</span> → <span>{String(diff.new ?? "—")}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Banner>
  );
}

function DeadlineList({ deadlines, canWrite }: { deadlines: Deadline[]; canWrite: boolean }) {
  const org = useOrg();
  const remove = useDeleteDeadline(org.id);
  return (
    <ul className="mt-4 divide-y divide-hairline">
      {deadlines.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          <span className="w-28 shrink-0 text-muted">{humanise(d.kind)}</span>
          <span className="tabular font-mono text-xs">{dateTime(d.due_at)}</span>
          {d.fired_at ? <Badge>sent</Badge> : <DeadlineChip at={d.due_at} />}
          <span className="min-w-0 flex-1 truncate text-muted">{d.note}</span>
          {canWrite && d.source !== "notice" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${d.kind} on ${dateTime(d.due_at)}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(d.id, { onSuccess: () => toast("Deadline removed") })}
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AddDeadlineDialog({ open, onClose, oppId }: { open: boolean; onClose: () => void; oppId: string }) {
  const org = useOrg();
  const add = useAddDeadline(org.id);
  const [when, setWhen] = useState("");
  const [kind, setKind] = useState<"custom" | "clarification">("custom");
  const [note, setNote] = useState("");
  const now = useNow();
  const future = when && new Date(when).getTime() > now;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Add a deadline"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!future}
            pending={add.isPending}
            onClick={async () => {
              await add.mutateAsync({ oppId, dueAt: new Date(when).toISOString(), note, kind });
              toast.success("Deadline added");
              setWhen("");
              setNote("");
              onClose();
            }}
          >
            Add deadline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Date and time (your local time)" error={when && !future ? "Pick a time in the future." : undefined}>
          {(props) => <Input {...props} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
        </Field>
        <Field label="Kind">
          {(props) => (
            <Select {...props} value={kind} onChange={(e) => setKind(e.target.value as "custom" | "clarification")}>
              <option value="custom">Internal milestone</option>
              <option value="clarification">Clarification question deadline</option>
            </Select>
          )}
        </Field>
        <Field label="Note (optional)">
          {(props) => <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-16" />}
        </Field>
      </div>
    </Dialog>
  );
}

const PRESETS = [14, 7, 3, 1];

function RemindersDialog({ open, onClose, oppId, hasSubmission }: { open: boolean; onClose: () => void; oppId: string; hasSubmission: boolean }) {
  const org = useOrg();
  const add = useAddReminders(org.id);
  const [days, setDays] = useState<number[]>([7, 3]);
  const toggle = (n: number) => setDays((current) => (current.includes(n) ? current.filter((d) => d !== n) : [...current, n]));
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Remind us before the submission deadline"
      description={hasSubmission ? "Reminders that would fall in the past are skipped." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!hasSubmission || days.length === 0}
            pending={add.isPending}
            onClick={async () => {
              const created = await add.mutateAsync({ oppId, daysBefore: [...days].sort((a, b) => b - a) });
              toast.success(created.length ? `${created.length} reminder${created.length === 1 ? "" : "s"} added` : "Those dates have already passed");
              onClose();
            }}
          >
            Add reminders
          </Button>
        </>
      }
    >
      {hasSubmission ? (
        <fieldset>
          <legend className="mb-2 text-sm text-muted">Days before</legend>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((n) => (
              <label key={n} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-hairline bg-surface-2 px-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="checkbox" className="accent-[var(--accent)]" checked={days.includes(n)} onChange={() => toggle(n)} />
                {n} {n === 1 ? "day" : "days"}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-sm text-muted">This opportunity has no submission deadline to count back from. Add a deadline instead.</p>
      )}
    </Dialog>
  );
}
