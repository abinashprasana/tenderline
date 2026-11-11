import { Activity } from "lucide-react";
import { motion } from "motion/react";

import { useRuns, type Run } from "@/api/hooks";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { date, dateTime, number } from "@/lib/format";

function duration(run: Run): string {
  if (!run.finished_at) return "running";
  const seconds = Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000);
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** New notices per run, oldest to newest, as a small bar sparkline. */
function Sparkline({ runs }: { runs: Run[] }) {
  const series = [...runs].reverse().slice(-40);
  const max = Math.max(1, ...series.map((r) => r.notices_new));
  return (
    <div className="flex h-16 items-end gap-[3px]" role="img" aria-label={`New notices in the last ${series.length} runs`}>
      {series.map((run, index) => (
        <motion.span
          key={run.id}
          title={`${dateTime(run.started_at)}: ${run.notices_new} new`}
          className={run.status === "ok" ? "flex-1 rounded-t-[2px] bg-chart-1" : "flex-1 rounded-t-[2px] bg-lost/70"}
          initial={{ height: 0 }}
          animate={{ height: `${Math.max((run.notices_new / max) * 100, 3)}%` }}
          transition={{ duration: 0.4, delay: index * 0.01, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}
    </div>
  );
}

export function Ingestion() {
  const runs = useRuns();
  return (
    <>
      <PageHeader
        title="Ingestion"
        description="Runs that collect notices from TED (the EU's Tenders Electronic Daily) and the eTenders open-data file."
      />
      {runs.isPending ? (
        <SkeletonRows />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <div className="panel">
          <EmptyState icon={<Activity className="size-5" />} title="No runs yet">
            The first scheduled run starts shortly after the server boots.
          </EmptyState>
        </div>
      ) : (
        <>
          <section className="panel mb-3 p-5">
            <h2 className="mb-3 text-sm text-muted">New notices per run</h2>
            <Sparkline runs={runs.data} />
          </section>
          <section className="panel overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-hairline">
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Seen</th>
                  <th className="px-4 py-2.5 text-right font-medium">New</th>
                  <th className="px-4 py-2.5 text-right font-medium">Updated</th>
                  <th className="px-4 py-2.5 text-right font-medium">Skipped</th>
                  <th className="px-4 py-2.5 font-medium">Took</th>
                </tr>
              </thead>
              <tbody className="tabular font-mono text-[0.8125rem]">
                {runs.data.map((run) => (
                  <tr key={run.id} className="border-b border-hairline align-top last:border-0">
                    <td className="px-4 py-2.5 font-sans">
                      {dateTime(run.started_at)}
                      {run.window_from ? <span className="block text-xs text-faint">from {date(run.window_from)}</span> : null}
                    </td>
                    <td className="px-4 py-2.5 font-sans">{run.source === "ted" ? "TED" : run.source === "etenders" ? "eTenders" : run.source}</td>
                    <td className="px-4 py-2.5 font-sans">
                      <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{run.status}</Badge>
                      {run.error ? <p className="mt-1 max-w-xs text-xs break-words text-lost">{run.error}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right">{number(run.notices_seen)}</td>
                    <td className="px-4 py-2.5 text-right">{number(run.notices_new)}</td>
                    <td className="px-4 py-2.5 text-right">{number(run.notices_updated)}</td>
                    <td className="px-4 py-2.5 text-right">{number(run.notices_skipped)}</td>
                    <td className="px-4 py-2.5">{duration(run)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
