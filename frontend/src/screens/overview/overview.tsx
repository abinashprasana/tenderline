import { Link } from "@tanstack/react-router";
import { AlarmClock, ArrowRight, Bell, CalendarClock, CheckCheck, Database, Inbox, KanbanSquare, PencilLine, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";

import { useAudit, useDeadlines, useMembers, useOpportunities, useProposals, useSearches, useSummary } from "@/api/hooks";
import { useOrg } from "@/app/org";
import { useSession } from "@/auth/use-session";
import { AuditTimeline } from "@/components/audit-timeline";
import { Checklist } from "@/components/checklist";
import { Ago } from "@/components/deadline-chip";
import { Term } from "@/components/term";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { previousVisit } from "@/lib/first-run";
import { countdown, greeting } from "@/lib/format";
import { plural, RUN_STATUS } from "@/lib/labels";
import { useNow } from "@/lib/use-now";

import { DeadlineRiver, FitBands, FitHistogram, NextDeadlines, PipelineBars, Ticker } from "./charts";
import { nextAction, sinceLastVisit, type NextAction } from "./today";

const EASE = [0.22, 1, 0.36, 1] as const;

export function Overview() {
  const org = useOrg();
  const session = useSession();
  const now = useNow();
  const summary = useSummary(org.id);
  const deadlines = useDeadlines(org.id, 30);
  const pending = useProposals(org.id, { status: "pending" });
  const opportunities = useOpportunities(org.id);
  const searches = useSearches(org.id);
  const activity = useAudit(org.id, {}, 50);
  const members = useMembers(org.id);
  // Read once per visit: when this person was last here before this sitting.
  const [lastVisit] = useState(() => previousVisit(org.id));
  const s = summary.data;
  const entries = activity.data?.pages[0]?.items;
  const titles = useMemo(
    () => new Map((opportunities.data?.items ?? []).map((o) => [o.id, o.notice_title])),
    [opportunities.data],
  );

  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  const action =
    s && deadlines.data && pending.data && opportunities.data && searches.data
      ? nextAction({
          now,
          deadlines: deadlines.data,
          pending: pending.data.items,
          opportunities: opportunities.data.items,
          watchlists: searches.data.items.length,
          assessing: s.matches_awaiting_assessment,
          titles,
        })
      : null;
  const news = lastVisit && entries ? sinceLastVisit(entries, lastVisit) : null;

  return (
    <>
      <PageHeader
        title={`${greeting(now)}${session ? `, ${session.login}` : ""}`}
        description={
          s
            ? s.notices_awaiting_decision
              ? `${plural(s.notices_awaiting_decision, "notice")} ${s.notices_awaiting_decision === 1 ? "is" : "are"} waiting for your decision.`
              : "Nothing is waiting for your decision."
            : " "
        }
        intro={{
          id: "today",
          text: (
            <>
              Tenderline collects public tender notices every day, keeps the ones that match your{" "}
              <Term k="watchlist">watchlists</Term>, and has an <Term k="assistant">assistant</Term> suggest what to do with
              each. This page shows what needs you now.
            </>
          ),
          points: [
            { icon: <Inbox className="size-4" />, title: "1. Decide", body: "Approve, edit or reject each suggestion in To decide." },
            { icon: <KanbanSquare className="size-4" />, title: "2. Follow", body: "Tenders you track move through the Pipeline." },
            { icon: <AlarmClock className="size-4" />, title: "3. Never miss it", body: "Deadlines and reminders are watched for you." },
          ],
        }}
      />

      <Checklist />

      <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <NextActionCard action={action} />
        <section className="panel flex flex-col p-5" aria-label="Since your last visit">
          <h2 className="text-sm font-medium text-muted">
            {lastVisit ? (
              <>
                Since you were last here, <Ago at={new Date(lastVisit).toISOString()} />
              </>
            ) : (
              "Your progress"
            )}
          </h2>
          {news && news.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {news.map((item) => (
                <li key={item.label} className="flex items-center gap-2 text-sm">
                  <span className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-accent-soft px-1.5 font-mono text-xs text-accent">
                    {item.count}
                  </span>
                  {item.label}
                </li>
              ))}
            </ul>
          ) : lastVisit && entries ? (
            <p className="mt-2 text-sm">Nothing new. You are up to date.</p>
          ) : null}
          {s ? (
            <dl className={cn("grid flex-1 auto-rows-fr grid-cols-2 gap-2", lastVisit ? "mt-3 border-t border-hairline pt-3" : "mt-3")}>
              <Stat label="Decided today" value={s.decisions_today} />
              <Stat label="Decided in 7 days" value={s.decisions_last_7_days} />
              <Stat label="Being assessed" value={s.matches_awaiting_assessment} />
              <Stat label="Watchlists" value={searches.data?.items.length} />
            </dl>
          ) : (
            <Skeleton className="mt-3 h-28" />
          )}
        </section>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi
          index={0}
          label="Notices to decide"
          value={s?.notices_awaiting_decision}
          icon={<Inbox className="size-4" />}
          to="/o/$orgId/approvals"
          accent
          hint={s ? plural(s.proposals_pending, "suggested action") : undefined}
        />
        <Kpi index={1} label="Open in your pipeline" value={s?.opportunities_open} icon={<KanbanSquare className="size-4" />} to="/o/$orgId/opportunities" />
        <Kpi
          index={2}
          label="Due in the next 7 days"
          value={s?.deadlines_next_7_days}
          icon={<CalendarClock className="size-4" />}
          to="/o/$orgId/deadlines"
          warn={Boolean(s?.deadlines_next_7_days)}
        />
        <Kpi
          index={3}
          label="New notices, last 24 hours"
          value={s?.notices_ingested_24h}
          icon={<Database className="size-4" />}
          to="/o/$orgId/notices"
          hint={
            s?.last_ingestion ? (
              <>
                checked <Ago at={s.last_ingestion.finished_at ?? s.last_ingestion.started_at} />
              </>
            ) : undefined
          }
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card
          title="Next 30 days"
          subtitle={s ? `${plural(s.deadlines_next_30_days, "deadline or reminder", "deadlines and reminders")}. Select a dot to open the tender.` : undefined}
        >
          {deadlines.isPending ? (
            <Skeleton className="h-24" />
          ) : deadlines.data?.length ? (
            <>
              <DeadlineRiver deadlines={deadlines.data} now={now} orgId={org.id} titles={titles} />
              <NextDeadlines deadlines={deadlines.data} now={now} orgId={org.id} titles={titles} />
            </>
          ) : (
            <EmptyState title="No deadlines coming up" className="py-6">
              Track a tender to see its submission deadline here.
            </EmptyState>
          )}
        </Card>
        <Card title="Your pipeline" subtitle="Tenders you are tracking, by status">
          {s ? (
            <>
              <PipelineBars byStatus={s.opportunities_by_status} orgId={org.id} />
              <PipelineOutcome byStatus={s.opportunities_by_status} />
            </>
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <Card
          title={
            <>
              How well waiting notices <Term k="fit">fit</Term>
            </>
          }
          subtitle="One bar per ten points of the assistant's fit score"
        >
          {s ? (
            s.notices_awaiting_decision ? (
              <>
                <FitHistogram buckets={s.fit_score_histogram} />
                <FitBands buckets={s.fit_score_histogram} orgId={org.id} />
              </>
            ) : (
              <EmptyState title="No notices waiting" className="py-6">
                Scores appear when the assistant has assessed new matches.
              </EmptyState>
            )
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
        <Card
          title="Recent activity"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/o/$orgId/audit" params={{ orgId: org.id }}>
                Full audit log
              </Link>
            </Button>
          }
        >
          {activity.isPending ? (
            <Skeleton className="h-40" />
          ) : entries?.length ? (
            <AuditTimeline entries={entries.slice(0, 5)} members={members.data ?? []} />
          ) : (
            <EmptyState title="No activity yet" className="py-6" />
          )}
        </Card>
      </div>

      {s?.last_ingestion ? (
        <p className="mt-4 text-xs text-muted">
          Notices come from TED and eTenders. Last check: {(RUN_STATUS[s.last_ingestion.status] ?? s.last_ingestion.status).toLowerCase()},{" "}
          <Ago at={s.last_ingestion.finished_at ?? s.last_ingestion.started_at} />, {plural(s.last_ingestion.notices_new, "new notice")}.
        </p>
      ) : null}
    </>
  );
}

const ACTION_ICON: Record<NextAction["kind"], ReactNode> = {
  deadline: <AlarmClock className="size-5" />,
  strong: <Sparkles className="size-5" />,
  decide: <Inbox className="size-5" />,
  changed: <PencilLine className="size-5" />,
  assessing: <Sparkles className="size-5" />,
  watchlist: <Bell className="size-5" />,
  clear: <CheckCheck className="size-5" />,
};

/** The one thing most worth doing now, chosen by simple rules (see today.ts). */
function NextActionCard({ action }: { action: NextAction | null }) {
  const org = useOrg();
  const now = useNow();
  if (!action) return <Skeleton className="h-36 rounded-[var(--radius-panel)]" />;
  const urgent = action.kind === "deadline";
  return (
    <motion.section
      data-wren-target="next-action"
      data-perch-x="72"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
      className={cn("panel relative overflow-hidden border-l-4 p-5 sm:p-7", urgent ? "border-soon/40" : action.kind === "clear" ? "" : "border-accent/40")}
      aria-labelledby="next-title"
    >
      <span aria-hidden className={cn("absolute -top-16 -right-16 size-48 rounded-full blur-3xl", urgent ? "bg-soon-soft" : "bg-accent-soft")} />
      <div className="relative flex items-start gap-4">
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", urgent ? "bg-soon-soft text-soon" : "bg-accent-soft text-accent")}>
          {ACTION_ICON[action.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-[0.06em] text-muted uppercase">{action.kind === "clear" ? "All clear" : "Do this next"}</p>
          <h2 id="next-title" className="mt-2 text-xl leading-snug font-semibold">
            {action.title}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {action.body}
            {action.due ? <span className="tabular ml-1 font-mono text-soon">{countdown(action.due, now)} left.</span> : null}
          </p>
          {action.to ? (
            <Button asChild variant={action.kind === "clear" ? "secondary" : "primary"} className="mt-4">
              <Link to={action.to} params={{ orgId: org.id, oppId: action.oppId ?? "" }} search={action.search ?? {}}>
                {action.cta} <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </motion.section>
  );
}

function Kpi({
  index,
  label,
  value,
  icon,
  to,
  accent,
  warn,
  hint,
}: {
  index: number;
  label: string;
  value: number | undefined;
  icon: ReactNode;
  to: "/o/$orgId/approvals" | "/o/$orgId/opportunities" | "/o/$orgId/deadlines" | "/o/$orgId/notices";
  accent?: boolean;
  warn?: boolean;
  hint?: ReactNode;
}) {
  const org = useOrg();
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, delay: index * 0.05, ease: EASE }}>
      <Link
        to={to}
        params={{ orgId: org.id }}
        className={cn(
          "panel group flex h-full flex-col gap-3 p-4 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-hairline-strong",
          accent && value ? "border-accent/40" : undefined,
        )}
      >
        <span className="flex items-center justify-between gap-2 text-sm text-muted">
          {label}
          <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2", accent && value ? "text-accent" : warn ? "text-soon" : "text-muted")}>
            {icon}
          </span>
        </span>
        <span className="text-[2rem] leading-none font-semibold tracking-[-0.02em]">
          {value === undefined ? <Skeleton className="h-8 w-12" /> : <Ticker value={value} />}
        </span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </Link>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex flex-col justify-between gap-2 rounded-lg bg-surface-2/60 px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular font-mono text-2xl leading-none">{value ?? "–"}</dd>
    </div>
  );
}

/** How decided tenders turned out, so the outcome bars read as a result rather than loose numbers. */
function PipelineOutcome({ byStatus }: { byStatus: Record<string, number> }) {
  const won = byStatus.won ?? 0;
  const lost = byStatus.lost ?? 0;
  const open = (byStatus.new ?? 0) + (byStatus.bid ?? 0) + (byStatus.submitted ?? 0);
  const decided = won + lost;
  return (
    <div className="mt-auto pt-4">
      <p className="border-t border-hairline pt-3 text-sm text-muted">
        <span className="tabular font-mono text-text">{open}</span> still open.{" "}
        {decided ? (
          <>
            Won <span className="tabular font-mono text-text">{won}</span> of {plural(decided, "awarded tender")} (
            <span className="tabular font-mono text-text">{Math.round((won / decided) * 100)}%</span>).
          </>
        ) : (
          "No awards yet."
        )}
      </p>
    </div>
  );
}

function Card({ title, subtitle, action, children }: { title: ReactNode; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel flex flex-col p-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
