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
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { humanise } from "@/lib/format";
import { downloadCalendar } from "@/lib/ics";
import { SCREEN } from "@/lib/labels";
import { useNow } from "@/lib/use-now";

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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
          <EmptyState illustration={<EmptyCalendar />} title="Nothing scheduled">
            Deadlines appear when you track a tender in your pipeline. Reminders are added from the tender's page.
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <section className="panel p-2 sm:p-4" aria-label="Agenda">
            {selectedDay ? (
              <div className="flex items-center justify-between px-2 pb-2">
                <p className="text-sm text-muted">Showing one day</p>
                <Button size="sm" variant="ghost" onClick={() => setSelectedDay(null)}>
                  Show all
                </Button>
              </div>
            ) : null}
            <ol className="flex flex-col">
              {days.map((key) => (
                <li key={key} className="border-b border-hairline last:border-0">
                  <h2 className="sticky top-16 bg-surface px-2 pt-3 pb-1 text-xs font-medium text-faint">
                    {new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${key}T12:00:00`))}
                  </h2>
                  <ul>
                    {byDay.get(key)!.map((d) => (
                      <li key={d.id}>
                        <Link
                          to="/o/$orgId/opportunities/$oppId"
                          params={{ orgId: org.id, oppId: d.opportunity_id }}
                          className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2"
                        >
                          <span className="tabular w-12 font-mono text-xs text-muted">
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
              ))}
            </ol>
          </section>
          <MonthHeatmap counts={byDay} selected={selectedDay} onSelect={setSelectedDay} />
        </div>
      )}
    </>
  );
}

function MonthHeatmap({ counts, selected, onSelect }: { counts: Map<string, Deadline[]>; selected: string | null; onSelect: (day: string | null) => void }) {
  const [offset, setOffset] = useState(0);
  const today = new Date();
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
      <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] text-faint" aria-hidden>
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
          return (
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
        })}
      </div>
    </section>
  );
}
