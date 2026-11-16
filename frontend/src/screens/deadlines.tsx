import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useMemo, useState } from "react";

import { useDeadlines, useOpportunities, type Deadline } from "@/api/hooks";
import { useOrg } from "@/app/org";
import { DeadlineChip } from "@/components/deadline-chip";
import { EmptyCalendar } from "@/components/illustrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, SkeletonRows, Tooltip } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { dayHeading, humanise } from "@/lib/format";
import { downloadCalendar } from "@/lib/ics";
import { plural, SCREEN } from "@/lib/labels";
import { useNow } from "@/lib/use-now";

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Monday 00:00 of the week containing `ms`, local time. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** "This week", "Next week" or "Later", for a yyyy-mm-dd day key. */
function weekGroup(key: string, now: number): string {
  const week = weekStart(now);
  const day = new Date(`${key}T12:00:00`).getTime();
  if (day < week + 7 * 86_400_000) return "This week";
  if (day < week + 14 * 86_400_000) return "Next week";
  return "Later";
}

export function Deadlines() {
  const org = useOrg();
  const deadlines = useDeadlines(org.id, 120);
  const opportunities = useOpportunities(org.id);
  const titles = useMemo(
    () => new Map((opportunities.data?.items ?? []).map((o) => [o.id, o.notice_title])),
    [opportunities.data],
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const now = useNow();

  const byDay = useMemo(() => {
    const upcoming = (deadlines.data ?? []).filter((d) => !d.fired_at && new Date(d.due_at).getTime() >= now - 86_400_000);
    const map = new Map<string, Deadline[]>();
    for (const d of upcoming) map.set(dayKey(d.due_at), [...(map.get(dayKey(d.due_at)) ?? []), d]);
    return map;
  }, [deadlines.data, now]);
  const upcoming = [...byDay.values()].flat();
  const days = [...byDay.keys()].sort().filter((key) => !selectedDay || key === selectedDay);

  return (
    <>
      <PageHeader
        title={SCREEN.deadlines}
        description="Submission deadlines and reminders for every tender in your pipeline, for the next four months."
        intro={{
          id: "deadlines",
          text: "Submission deadlines come from the notices themselves and move if the buyer changes them. Reminders are yours: add them from a tender's page, or approve the assistant's suggestion.",
        }}
        actions={
          upcoming.length ? (
            <Button
              data-wren-target="export-calendar"
              size="sm"
              onClick={() => {
                downloadCalendar(
                  "tenderline-deadlines.ics",
                  upcoming.map((d) => ({
                    id: d.id,
                    at: d.due_at,
                    title: `${d.kind === "submission" ? "Submission deadline" : humanise(d.kind)}: ${titles.get(d.opportunity_id) ?? "Tender"}`,
                    description: d.note ?? undefined,
                  })),
                );
                toast.success("Calendar file downloaded. Open it to add the dates to your calendar.");
              }}
            >
              <CalendarDays className="size-3.5" /> Add all to calendar
            </Button>
          ) : null
        }
      />
      {deadlines.isPending ? (
        <SkeletonRows />
      ) : deadlines.isError ? (
        <ErrorState error={deadlines.error} onRetry={() => void deadlines.refetch()} />
      ) : upcoming.length === 0 ? (
        <div className="panel">
          <EmptyState illustration={<EmptyCalendar />} title="Nothing scheduled" action={<Button asChild><Link to="/o/$orgId/opportunities" params={{ orgId: org.id }}>Open your pipeline</Link></Button>}>
            Deadlines appear when you track a tender in your pipeline. Reminders are added from the tender's page.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="panel p-2 sm:p-4" aria-label="Agenda">
            {selectedDay ? (
              <div className="flex items-center justify-between px-2 pb-2">
                <p className="text-sm text-muted">{dayHeading(`${selectedDay}T12:00:00`, now)}</p>
                <Button size="sm" variant="ghost" onClick={() => setSelectedDay(null)}>
                  Show all
                </Button>
              </div>
            ) : null}
            <ol className="flex flex-col">
              {days.map((key, index) => {
                const group = weekGroup(key, now);
                const firstOfGroup = index === 0 || weekGroup(days[index - 1]!, now) !== group;
                const count = days.filter((k) => weekGroup(k, now) === group).reduce((sum, k) => sum + (byDay.get(k)?.length ?? 0), 0);
                return (
                <li key={key} className="border-b border-hairline last:border-0">
                  {firstOfGroup && !selectedDay ? (
                    <p className="flex items-baseline gap-2 px-2 pt-5 pb-1 first:pt-2">
                      <span className="text-sm font-semibold">{group}</span>
                      <span className="text-xs text-muted">{plural(count, "item")}</span>
                    </p>
                  ) : null}
                  <h2 className="sticky top-16 z-10 bg-surface px-2 pt-3 pb-1 text-xs font-medium text-muted">
                    {dayHeading(`${key}T12:00:00`, now)}
                    {["Today", "Tomorrow"].includes(dayHeading(`${key}T12:00:00`, now))
                      ? `, ${new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${key}T12:00:00`))}`
                      : ""}
                  </h2>
                  <ul>
                    {byDay.get(key)!.map((d) => (
                      <li key={d.id}>
                        <Link
                          to="/o/$orgId/opportunities/$oppId"
                          params={{ orgId: org.id, oppId: d.opportunity_id }}
                          className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2"
                        >
                          <span className="tabular w-12 shrink-0 font-mono text-xs text-muted">
                            {new Intl.DateTimeFormat("en-IE", { hour: "2-digit", minute: "2-digit" }).format(new Date(d.due_at))}
                          </span>
                          <Badge tone={d.kind === "submission" ? "lost" : d.kind === "reminder" ? "soon" : "info"}>{humanise(d.kind)}</Badge>
                          <span className="min-w-0 flex-1 truncate text-sm">{titles.get(d.opportunity_id) ?? "Opportunity"}</span>
                          <DeadlineChip at={d.due_at} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
                );
              })}
            </ol>
          </section>
          <MonthHeatmap counts={byDay} titles={titles} now={now} selected={selectedDay} onSelect={setSelectedDay} />
        </div>
      )}
    </>
  );
}

function MonthHeatmap({
  counts,
  titles,
  now,
  selected,
  onSelect,
}: {
  counts: Map<string, Deadline[]>;
  titles: Map<string, string>;
  now: number;
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const [offset, setOffset] = useState(0);
  const today = new Date(now);
  const first = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday first
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const max = Math.max(1, ...[...counts.values()].map((list) => list.length));
  return (
    <section className="panel h-fit p-4" aria-label="Month view">
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="icon" aria-label="Previous month" disabled={offset <= 0} onClick={() => setOffset((o) => o - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <h2 className="text-sm font-medium">{new Intl.DateTimeFormat("en-IE", { month: "long", year: "numeric" }).format(first)}</h2>
        <Button variant="ghost" size="icon" aria-label="Next month" disabled={offset >= 3} onClick={() => setOffset((o) => o + 1)}>
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] text-muted" aria-hidden>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const list = counts.get(key) ?? [];
          const intensity = list.length / max;
          const isToday = offset === 0 && day === today.getDate();
          const describe = list
            .slice(0, 4)
            .map((d) => `${d.kind === "submission" ? "Submission" : humanise(d.kind)}: ${titles.get(d.opportunity_id) ?? "a tracked tender"}`)
            .join("\n");
          const cell = (
            <button
              key={key}
              disabled={list.length === 0}
              onClick={() => onSelect(selected === key ? null : key)}
              aria-pressed={selected === key}
              aria-label={`${day}: ${list.length} ${list.length === 1 ? "deadline" : "deadlines"}`}
              className={cn(
                "tabular grid aspect-square place-items-center rounded-md text-xs transition-shadow",
                list.length ? "text-text" : "text-faint",
                isToday && "ring-1 ring-accent",
                selected === key && "ring-2 ring-accent",
              )}
              style={list.length ? { background: `color-mix(in oklch, var(--soon) ${18 + intensity * 50}%, transparent)` } : undefined}
            >
              {day}
            </button>
          );
          return list.length ? (
            <Tooltip key={key} label={<span className="whitespace-pre-line">{describe + (list.length > 4 ? `\n+${list.length - 4} more` : "")}</span>}>
              {cell}
            </Tooltip>
          ) : (
            cell
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[0.6875rem] text-muted" aria-hidden>
        Fewer
        {[18, 35, 52, 68].map((pct) => (
          <span key={pct} className="size-3 rounded-sm" style={{ background: `color-mix(in oklch, var(--soon) ${pct}%, transparent)` }} />
        ))}
        More deadlines on a day
      </div>
      <p className="mt-2 text-xs text-muted">Select a day to see only its deadlines.</p>
    </section>
  );
}
