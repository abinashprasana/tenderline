import { useNavigate, useSearch } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";

import { useAudit, useMembers } from "@/api/hooks";
import { useOrg } from "@/app/org";
import { AuditTimeline } from "@/components/audit-timeline";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";

const ENTITIES = [
  ["agent_proposal", "Proposals"],
  ["opportunity", "Opportunities"],
  ["deadline", "Deadlines"],
  ["match", "Matches"],
  ["saved_search", "Saved searches"],
  ["membership", "Members"],
  ["organisation", "Organisation"],
] as const;

export function AuditLog() {
  const org = useOrg();
  const search = useSearch({ from: "/o/$orgId/audit" });
  const navigate = useNavigate({ from: "/o/$orgId/audit" });
  const members = useMembers(org.id);
  const audit = useAudit(org.id, { actor_type: search.actor, entity_type: search.entity, entity_id: search.id }, 50);
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every proposal, decision and change, by a person or the agent. Read-only: entries cannot be edited or deleted."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Who"
              className="w-40"
              value={search.actor ?? ""}
              onChange={(e) => void navigate({ search: (prev) => ({ ...prev, actor: (e.target.value || undefined) as "human" | "agent" | undefined }) })}
            >
              <option value="">People and agent</option>
              <option value="human">People</option>
              <option value="agent">Agent</option>
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
          <EmptyState icon={<ScrollText className="size-5" />} title="No entries for this filter" />
        ) : (
          <>
            <AuditTimeline entries={entries} members={members.data ?? []} stagger={false} />
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
