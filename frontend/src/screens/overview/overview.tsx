import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CalendarClock, Database, Inbox, KanbanSquare } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { useAudit, useDeadlines, useMembers, useSummary } from "@/api/hooks";
import { useOrg } from "@/app/org";
import { AuditTimeline } from "@/components/audit-timeline";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { greeting, relative } from "@/lib/format";
import { useNow } from "@/lib/use-now";

import { DeadlineRiver, FitHistogram, PipelineBars, Ticker } from "./charts";

const EASE = [0.22, 1, 0.36, 1] as const;

export function Overview() {
  const org = useOrg();
  const summary = useSummary(org.id);
  const deadlines = useDeadlines(org.id, 30);
  const activity = useAudit(org.id, {}, 8);
  const members = useMembers(org.id);
  const s = summary.data;
  const now = useNow();

  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  return (
    <>
      <PageHeader
        title={greeting(now)}
        description={
          s
            ? s.proposals_pending
              ? `${s.notices_awaiting_decision} ${s.notices_awaiting_decision === 1 ? "notice is" : "notices are"} waiting for a decision.`
              : "Nothing is waiting for a decision."
            : " "
        }
        actions={
          s?.proposals_pending ? (
            <Button asChild variant="primary">
              <Link to="/o/$orgId/approvals" params={{ orgId: org.id }}>
                Review approvals <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi index={0} label="Actions to approve" value={s?.proposals_pending} icon={<Inbox className="size-4" />} to="/o/$orgId/approvals" accent />
        <Kpi index={1} label="Open opportunities" value={s?.opportunities_open} icon={<KanbanSquare className="size-4" />} to="/o/$orgId/opportunities" />
        <Kpi index={2} label="Deadlines in 7 days" value={s?.deadlines_next_7_days} icon={<CalendarClock className="size-4" />} to="/o/$orgId/deadlines" warn={Boolean(s?.deadlines_next_7_days)} />
        <Kpi index={3} label="New notices, last 24 hours" value={s?.notices_ingested_24h} icon={<Database className="size-4" />} to="/o/$orgId/notices" hint={s?.last_ingestion ? `last run ${relative(s.last_ingestion.finished_at ?? s.last_ingestion.started_at)}` : undefined} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Next 30 days" subtitle={s ? `${s.deadlines_next_30_days} ${s.deadlines_next_30_days === 1 ? "deadline or reminder" : "deadlines and reminders"}` : undefined}>
          {deadlines.isPending ? (
            <Skeleton className="h-24" />
          ) : deadlines.data?.length ? (
            <DeadlineRiver deadlines={deadlines.data} now={now} />
          ) : (
            <EmptyState title="No deadlines coming up" className="py-6">
              Track an opportunity to see its submission deadline here.
            </EmptyState>
          )}
        </Card>
        <Card title="Pipeline" subtitle="Opportunities by status">
          {s ? <PipelineBars byStatus={s.opportunities_by_status} /> : <Skeleton className="h-36" />}
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <Card title="How well waiting notices fit" subtitle="Agent fit score, per notice">
          {s ? (
            s.notices_awaiting_decision ? (
              <FitHistogram buckets={s.fit_score_histogram} />
            ) : (
              <EmptyState title="No notices waiting" className="py-6">
                Scores appear when the agent has assessed new matches.
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
                Audit log
              </Link>
            </Button>
          }
        >
          {activity.isPending ? (
            <Skeleton className="h-40" />
          ) : activity.data?.pages[0]?.items.length ? (
            <AuditTimeline entries={activity.data.pages[0].items} members={members.data ?? []} />
          ) : (
            <EmptyState title="No activity yet" className="py-6" />
          )}
        </Card>
      </div>

      {s?.last_ingestion ? (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-faint">
          Data from TED and eTenders. Last collection
          <Badge tone={STATUS_TONE[s.last_ingestion.status] ?? "neutral"}>{s.last_ingestion.status}</Badge>
          {relative(s.last_ingestion.finished_at ?? s.last_ingestion.started_at)}, {s.last_ingestion.notices_new} new.
        </p>
      ) : null}
    </>
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
  hint?: string;
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
        <span className="flex items-center justify-between text-sm text-muted">
          {label}
          <span className={cn("grid size-7 place-items-center rounded-lg bg-surface-2", accent && value ? "text-accent" : warn ? "text-soon" : "text-faint")}>{icon}</span>
        </span>
        <span className="text-[2rem] leading-none font-semibold tracking-[-0.02em]">
          {value === undefined ? <Skeleton className="h-8 w-12" /> : <Ticker value={value} />}
        </span>
        {hint ? <span className="text-xs text-faint">{hint}</span> : null}
      </Link>
    </motion.div>
  );
}

function Card({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel flex flex-col p-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          {subtitle ? <p className="text-xs text-faint">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
