import { useNavigate, useSearch } from "@tanstack/react-router";

import { useAudit, useMembers } from "@/api/hooks";
import { useOrg } from "@/app/org";
import { useState } from "react";

import { actorName, AuditTimeline, describeAction } from "@/components/audit-timeline";
import { EmptyLog } from "@/components/illustrations";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";

const ENTITIES = [
  ["agent_proposal", "Suggestions"],
  ["opportunity", "Pipeline"],
  ["deadline", "Deadlines"],
  ["match", "Matched notices"],
  ["saved_search", "Watchlists"],
  ["membership", "Members"],
  ["organisation", "Organisation"],
] as const;

export function AuditLog() {
  const org = useOrg();
  const search = useSearch({ from: "/o/$orgId/audit" });
  const navigate = useNavigate({ from: "/o/$orgId/audit" });
  const members = useMembers(org.id);
  const audit = useAudit(org.id, { actor_type: search.actor, entity_type: search.entity, entity_id: search.id }, 50);
  const members_ = members.data ?? [];
  const [words, setWords] = useState("");
  const all = audit.data?.pages.flatMap((page) => page.items) ?? [];
  // Search the entries already loaded, by what a person reads: who did it and what they did.
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = terms.length
    ? all.filter((entry) => {
        const text = `${actorName(entry, members_)} ${describeAction(entry.action)} ${entry.action}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
    : all;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every suggestion, decision and change, by a person or the assistant. Nothing here can be edited or deleted."
        intro={{
          id: "audit",
          text: "If you ever need to show who decided what, and when, it is here. Open Details on an entry to see exactly what changed.",
        }}
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              type="search"
              aria-label="Search the log"
              placeholder="Search, e.g. rejected"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              className="w-48"
            />
            <Select
              aria-label="Who"
              className="w-40"
              value={search.actor ?? ""}
              onChange={(e) => void navigate({ search: (prev) => ({ ...prev, actor: (e.target.value || undefined) as "human" | "agent" | undefined }) })}
            >
              <option value="">People and the assistant</option>
              <option value="human">People</option>
              <option value="agent">The assistant</option>
            </Select>
            <Select
              aria-label="What"
              className="w-44"
              value={search.entity ?? ""}
              onChange={(e) => void navigate({ search: (prev) => ({ ...prev, entity: e.target.value || undefined, id: undefined }) })}
            >
              <option value="">Everything</option>
              {ENTITIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <section className="panel px-4 py-2 sm:px-6">
        {audit.isPending ? (
          <SkeletonRows className="py-4" />
        ) : audit.isError ? (
          <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState illustration={<EmptyLog />} title={terms.length ? `Nothing matches “${words.trim()}”` : "No entries for this filter"} />
        ) : (
          <>
            <AuditTimeline entries={entries} members={members_} stagger={false} byDay />
            {terms.length && audit.hasNextPage ? (
              <p className="pt-2 text-center text-xs text-muted">Searching the {all.length} most recent entries. Load older ones to search further back.</p>
            ) : null}
            {audit.hasNextPage ? (
              <div className="flex justify-center py-4">
                <Button size="sm" pending={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                  Load older entries
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
