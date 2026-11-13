import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useMatches, useProposals, useQualify, useSearches, type Match } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { Ago, DeadlineChip } from "@/components/deadline-chip";
import { Watching } from "@/components/illustrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { humanise } from "@/lib/format";
import { plural, SCREEN } from "@/lib/labels";

const RULE_LABEL: Record<string, string> = {
  cpv: "Category",
  keywords: "Keyword",
  buyer: "Buyer",
  country: "Country",
  value: "Value €",
  value_unknown: "Value not stated",
};

/** Why a notice matched: the saved-search rules it met, as the matcher recorded them (src/tenderline/matching.py). */
function reasonChips(reasons: Match["reasons"]): string[] {
  if (!reasons || typeof reasons !== "object") return [];
  return Object.entries(reasons as Record<string, unknown>).flatMap(([rule, value]) => {
    const label = RULE_LABEL[rule] ?? humanise(rule);
    if (Array.isArray(value)) return value.map((v) => `${label}: ${String(v)}`);
    if (value === true) return [label];
    if (value === null || value === false || value === undefined) return [];
    return [`${label}: ${rule === "value" ? String(value).split(".")[0] : String(value)}`];
  });
}

export function Matches() {
  const org = useOrg();
  const search = useSearch({ from: "/o/$orgId/matches" });
  const navigate = useNavigate({ from: "/o/$orgId/matches" });
  const searches = useSearches(org.id);
  const matches = useMatches(org.id, { saved_search_id: search.search });
  const pending = useProposals(org.id, { status: "pending" });
  const awaiting = new Set((pending.data?.items ?? []).map((p) => p.match_id));
  const names = new Map((searches.data?.items ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader
        title={SCREEN.matched}
        description="Notices that met one of your watchlists. The assistant assesses each one and suggests what to do."
        intro={{
          id: "matched",
          text: "This is the list behind To decide: every notice a watchlist caught, with why it matched. Use it to check a watchlist is catching the right things.",
        }}
        actions={
          <Select
            aria-label="Watchlist"
            value={search.search ?? ""}
            onChange={(e) => void navigate({ search: { search: e.target.value || undefined } })}
            className="w-56"
          >
            <option value="">All watchlists</option>
            {(searches.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        }
      />
      {matches.isPending ? (
        <SkeletonRows />
      ) : matches.isError ? (
        <ErrorState error={matches.error} onRetry={() => void matches.refetch()} />
      ) : matches.data.items.length === 0 ? (
        <div className="panel">
          <EmptyState
            illustration={<Watching />}
            title="No matched notices yet"
            action={
              <Button asChild variant="primary">
                <Link to="/o/$orgId/searches" params={{ orgId: org.id }}>
                  Edit watchlists
                </Link>
              </Button>
            }
          >
            New notices are checked against your watchlists as they arrive. A broader category or fewer keywords finds more.
          </EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groupByWatchlist(matches.data.items).map(([searchId, items]) => {
            const waitingHere = items.filter((m) => awaiting.has(m.id)).length;
            const assessing = items.filter((m) => !m.qualified_at).length;
            return (
              <section key={searchId} aria-labelledby={`wl-${searchId}`}>
                <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
                  <h2 id={`wl-${searchId}`} className="font-medium">
                    {names.get(searchId) ?? "A deleted watchlist"}
                  </h2>
                  <p className="text-sm text-muted">
                    {plural(items.length, "notice")}
                    {waitingHere ? ` · ${waitingHere} waiting for you` : ""}
                    {assessing ? ` · ${assessing} being assessed` : ""}
                  </p>
                </header>
                <ul className="flex flex-col gap-2">
                  {items.map((match) => (
                    <MatchRow key={match.id} match={match} waiting={awaiting.has(match.id)} />
                  ))}
                </ul>
              </section>
            );
          })}
          {matches.data.next_cursor ? (
            <p className="text-center text-xs text-muted">Showing the 200 most recent matches. Pick one watchlist above to see its own.</p>
          ) : null}
        </div>
      )}
    </>
  );
}

/** Matches per watchlist, in the order the watchlists first appear (newest match first). */
function groupByWatchlist(items: Match[]): [string, Match[]][] {
  const groups = new Map<string, Match[]>();
  for (const match of items) groups.set(match.saved_search_id, [...(groups.get(match.saved_search_id) ?? []), match]);
  return [...groups.entries()];
}

function MatchRow({ match, waiting }: { match: Match; waiting: boolean }) {
  const org = useOrg();
  const canWrite = useCan("write");
  const qualify = useQualify(org.id);
  const [queued, setQueued] = useState(false);
  const qualified = Boolean(match.qualified_at);
  return (
    <li className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Link
          to="/o/$orgId/notices"
          params={{ orgId: org.id }}
          search={{ notice: match.notice_id }}
          className="line-clamp-2 text-sm font-medium hover:text-accent"
        >
          {match.notice_title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DeadlineChip at={match.notice_deadline_at} />
          {reasonChips(match.reasons)
            .slice(0, 4)
            .map((reason) => (
              <Badge key={reason} tone="info">
                {reason}
              </Badge>
            ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {waiting ? (
          <Button asChild size="sm" variant="primary">
            <Link to="/o/$orgId/approvals" params={{ orgId: org.id }} search={{ notice: match.notice_id }}>
              Decide
            </Link>
          </Button>
        ) : queued ? (
          <Badge tone="agent" icon={<span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}>
            The assistant is assessing
          </Badge>
        ) : (
          <span className="text-xs text-muted">
            {qualified ? (
              <>
                Assessed <Ago at={match.qualified_at} />
              </>
            ) : (
              "Waiting for the assistant"
            )}
          </span>
        )}
        {canWrite && !waiting ? (
          <Button
            size="sm"
            pending={qualify.isPending}
            onClick={() =>
              qualify.mutate(
                { matchId: match.id },
                {
                  onSuccess: () => {
                    setQueued(true);
                    toast("Sent to the assistant. Its suggestions will appear in To decide.");
                  },
                },
              )
            }
          >
            <RefreshCw className="size-3.5" /> {qualified ? "Assess again" : "Assess now"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
