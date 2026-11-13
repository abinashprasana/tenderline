import { Bot, ChevronDown, Copy, User } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";

import type { AuditEntry, Member } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { dateTime, dayHeading, humanise, relative } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const GRAFANA = import.meta.env.VITE_GRAFANA_URL as string | undefined;

/** Grafana Explore link for a Tempo trace, when VITE_GRAFANA_URL is set at build time. */
function traceLink(traceId: string): string | null {
  if (!GRAFANA) return null;
  const left = JSON.stringify({ datasource: "tempo", queries: [{ refId: "A", queryType: "traceql", query: traceId }] });
  return `${GRAFANA.replace(/\/$/, "")}/explore?orgId=1&left=${encodeURIComponent(left)}`;
}

export function actorName(entry: AuditEntry, members: Member[]): string {
  if (entry.actor_type === "agent") return entry.actor_id.startsWith("qualifier") ? "The assistant" : humanise(entry.actor_id);
  const member = members.find((m) => m.user_id === entry.actor_id);
  return member ? (member.name ?? member.login) : "A former member";
}

export function AuditTimeline({
  entries,
  members,
  stagger = true,
  byDay = false,
}: {
  entries: AuditEntry[];
  members: Member[];
  stagger?: boolean;
  /** Put a "Today" / "Yesterday" / date heading above each day's entries. */
  byDay?: boolean;
}) {
  const now = useNow();
  return (
    <ol className="relative flex flex-col">
      <span className="absolute top-2 bottom-2 left-[15px] w-px bg-hairline" aria-hidden />
      {entries.map((entry, index) => (
        <motion.li
          key={entry.id}
          initial={stagger ? { opacity: 0, x: -4 } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, delay: stagger ? Math.min(index, 12) * 0.03 : 0, ease: [0.22, 1, 0.36, 1] }}
        >
          {byDay && (index === 0 || dayKey(entries[index - 1]!.occurred_at) !== dayKey(entry.occurred_at)) ? (
            <h2 className="relative z-10 -ml-1 mt-3 mb-1 inline-block rounded-full bg-surface px-2 py-0.5 text-xs font-semibold first:mt-0">
              {dayHeading(entry.occurred_at, now)}
            </h2>
          ) : null}
          <AuditRow entry={entry} members={members} />
        </motion.li>
      ))}
    </ol>
  );
}

function AuditRow({ entry, members }: { entry: AuditEntry; members: Member[] }) {
  const [open, setOpen] = useState(false);
  const agent = entry.actor_type === "agent";
  const hasDiff = entry.before !== null || entry.after !== null;
  const link = entry.trace_id ? traceLink(entry.trace_id) : null;
  return (
    <div className="relative flex gap-3 py-2.5">
      <span
        className={cn(
          "z-10 grid size-8 shrink-0 place-items-center rounded-full border",
          agent ? "border-agent/30 bg-agent-soft text-agent" : "border-hairline bg-surface-2 text-muted",
        )}
        aria-hidden
      >
        {agent ? <Bot className="size-4" /> : <User className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-sm">
          <span className="font-medium">{actorName(entry, members)}</span>{" "}
          <span className="text-muted">{describeAction(entry.action)}</span>
          <EntityLink entry={entry} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <time dateTime={entry.occurred_at} title={dateTime(entry.occurred_at)}>
            {relative(entry.occurred_at)}
          </time>
          {entry.trace_id ? (
            <span className="inline-flex items-center gap-1">
              trace <code className="font-mono">{entry.trace_id.slice(0, 12)}</code>
              <button
                className="rounded p-0.5 hover:bg-surface-3 hover:text-text"
                aria-label="Copy trace id"
                onClick={() => navigator.clipboard.writeText(entry.trace_id ?? "").then(() => toast.success("Trace id copied"))}
              >
                <Copy className="size-3" />
              </button>
              {link ? (
                <a className="underline decoration-hairline-strong underline-offset-2 hover:text-text" href={link} target="_blank" rel="noreferrer noopener">
                  open in Tempo
                </a>
              ) : null}
            </span>
          ) : null}
          {hasDiff ? (
            <button
              className="inline-flex items-center gap-0.5 hover:text-text"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              Details <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            </button>
          ) : null}
        </p>
        {open ? <Diff before={entry.before} after={entry.after} /> : null}
      </div>
    </div>
  );
}

const VERBS: Record<string, string> = {
  "proposal.created": "suggested an action",
  "proposal.approved": "approved a suggestion",
  "proposal.edited": "edited and approved a suggestion",
  "proposal.rejected": "rejected a suggestion",
  "proposal.executed": "ran an approved action",
  "proposal.failed": "could not run an approved action",
  "proposal.cancelled": "withdrew a suggestion after the notice changed",
  "match.qualified": "assessed a matching notice",
  "match.refreshed": "re-matched a changed notice",
  "match.qualify_requested": "asked the assistant to assess a notice",
  "opportunity.created": "started tracking a tender",
  "opportunity.status_changed": "moved a tender in the pipeline",
  "opportunity.flagged_changed": "flagged that the notice changed",
  "deadline.created": "added a deadline",
  "deadline.deleted": "removed a deadline",
  "deadline.passed": "recorded that the submission deadline passed",
  "reminder.fired": "sent a reminder",
  "match.created": "found a matching notice",
  "opportunity.reviewer_assigned": "assigned a reviewer",
  "saved_search.created": "created a watchlist",
  "saved_search.updated": "updated a watchlist",
  "saved_search.deleted": "deleted a watchlist",
  "organisation.created": "created the organisation",
  "organisation.updated": "updated the organisation",
  "membership.added": "added a member",
  "membership.role_changed": "changed a member's role",
  "membership.removed": "removed a member",
};

export function describeAction(action: string): string {
  return VERBS[action] ?? humanise(action).toLowerCase();
}

/** Before / after as key-by-key rows. Values are shown as text, never interpreted. */
function Diff({ before, after }: { before: unknown; after: unknown }) {
  const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return (
    <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-hairline bg-bg-deep/50 p-3 text-xs">
      {keys.map((key) => {
        const changed = JSON.stringify(b[key]) !== JSON.stringify(a[key]);
        return (
          <div key={key} className="contents">
            <dt className="text-faint">{humanise(key)}</dt>
            <dd className="min-w-0 font-mono break-words">
              {key in b && changed ? <span className="text-lost line-through decoration-lost/50">{show(b[key])}</span> : null}
              {key in b && changed && key in a ? " → " : null}
              <span className={changed && key in a ? "text-won" : "text-muted"}>{key in a ? show(a[key]) : null}</span>
              {!(key in a) && !changed ? show(b[key]) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const dayKey = (iso: string) => new Date(iso).toDateString();

/** A short "open" link to what the entry is about, when there is a screen for it. */
function EntityLink({ entry }: { entry: AuditEntry }) {
  const { orgId } = useParams({ strict: false }) as { orgId?: string };
  if (!orgId) return null;
  const className = "ml-1.5 text-xs text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent";
  if (entry.entity_type === "opportunity")
    return (
      <Link to="/o/$orgId/opportunities/$oppId" params={{ orgId, oppId: entry.entity_id }} className={className}>
        open tender
      </Link>
    );
  if (entry.entity_type === "saved_search" && entry.action !== "saved_search.deleted")
    return (
      <Link to="/o/$orgId/matches" params={{ orgId }} search={{ search: entry.entity_id }} className={className}>
        see matches
      </Link>
    );
  return null;
}
