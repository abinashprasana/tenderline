import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useMatches, useProposals, useQualify, useSearches, type Match } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { DeadlineChip } from "@/components/deadline-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { humanise, relative } from "@/lib/format";

const RULE_LABEL: Record<string, string> = {
  cpv: "CPV",
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
        title="Matches"
        description="Notices that met one of your saved searches. The agent assesses each one and proposes what to do."
        actions={
          <Select
            aria-label="Saved search"
            value={search.search ?? ""}
            onChange={(e) => void navigate({ search: { search: e.target.value || undefined } })}
            className="w-56"
          >
            <option value="">All saved searches</option>
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
            icon={<Sparkles className="size-5" />}
            title="No matches yet"
            action={
              <Button asChild variant="primary">
                <Link to="/o/$orgId/searches" params={{ orgId: org.id }}>
                  Edit saved searches
                </Link>
              </Button>
            }
          >
            New notices are checked against your saved searches as they arrive. A broader CPV code or fewer keywords finds more.
          </EmptyState>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {matches.data.items.map((match) => (
            <MatchRow key={match.id} match={match} searchName={names.get(match.saved_search_id)} waiting={awaiting.has(match.id)} />
          ))}
        </ul>
      )}
    </>
  );
}

function MatchRow({ match, searchName, waiting }: { match: Match; searchName?: string; waiting: boolean }) {
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
          {searchName ? <Badge>{searchName}</Badge> : null}
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
            Agent is assessing
          </Badge>
        ) : (
          <span className="text-xs text-faint">{qualified ? `Assessed ${relative(match.qualified_at)}` : "Not assessed yet"}</span>
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
                    toast("Queued for the agent. Proposals will appear in Approvals.");
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
