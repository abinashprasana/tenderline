import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, X } from "lucide-react";
import { motion } from "motion/react";

import { useAudit, useDeadlines, useMembers, useOrgDetails, useSearches, useSummary } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { cn } from "@/lib/cn";
import { useDismissed } from "@/lib/first-run";

import { Button } from "./ui/button";

interface Step {
  title: string;
  why: string;
  done: boolean;
  to: "/o/$orgId/settings" | "/o/$orgId/searches" | "/o/$orgId/approvals" | "/o/$orgId/opportunities" | "/o/$orgId/deadlines";
}

/**
 * "Getting started" on the Today screen. Every tick comes from real data (a watchlist exists, a decision
 * was made), so it cannot drift from what the person has actually done. Hidden once dismissed or complete.
 */
export function Checklist() {
  const org = useOrg();
  const isOwner = useCan("admin");
  const [dismissed, setDismissed] = useDismissed(`checklist.${org.id}`);
  const details = useOrgDetails(org.id);
  const searches = useSearches(org.id);
  const summary = useSummary(org.id);
  const decisions = useAudit(org.id, { actor_type: "human", action_prefix: "proposal." }, 1);
  const deadlines = useDeadlines(org.id, 365);
  const members = useMembers(org.id);

  const loaded = details.data && searches.data && summary.data && decisions.data && deadlines.data && members.data;
  if (dismissed || !loaded) return null;

  const tracked = Object.values(summary.data.opportunities_by_status).reduce((sum, n) => sum + n, 0) > 0;
  const steps: Step[] = [
    {
      title: "Describe your company",
      why: "The assistant reads this to judge whether a tender fits.",
      done: Boolean((details.data.profile as { description?: string }).description),
      to: "/o/$orgId/settings",
    },
    { title: "Create a watchlist", why: "Tells Tenderline which notices to bring to you.", done: searches.data.items.length > 0, to: "/o/$orgId/searches" },
    {
      title: "Decide your first suggestion",
      why: "Approve, edit or reject what the assistant proposes.",
      done: (decisions.data.pages[0]?.items.length ?? 0) > 0,
      to: "/o/$orgId/approvals",
    },
    { title: "Track a tender in your pipeline", why: "Approve a “Track in the pipeline” suggestion, or track any notice yourself.", done: tracked, to: "/o/$orgId/opportunities" },
    {
      title: "Add a reminder",
      why: "So a submission deadline never arrives unannounced.",
      done: deadlines.data.some((d) => d.kind === "reminder"),
      to: "/o/$orgId/opportunities",
    },
    ...(isOwner
      ? [{ title: "Invite a teammate", why: "Reviewers can decide suggestions with you.", done: members.data.length > 1, to: "/o/$orgId/settings" } as Step]
      : []),
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const next = steps.find((s) => !s.done);
  const size = 44;
  const radius = 18;
  const circumference = 2 * Math.PI * radius;

  return (
    <section className="panel mb-3 p-5" aria-labelledby="checklist-title">
      <header className="flex items-start gap-4">
        <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
          <svg width={size} height={size} className="-rotate-90">
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth="4" />
            <motion.circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={false}
              animate={{ strokeDashoffset: circumference * (1 - doneCount / steps.length) }}
              transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
            />
          </svg>
          <span className="tabular absolute font-mono text-xs">
            {doneCount}/{steps.length}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="checklist-title" className="font-medium">
            Getting started
          </h2>
          <p className="text-sm text-muted">
            {doneCount} of {steps.length} done. {next ? `Next: ${next.title.toLowerCase()}.` : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Hide getting started" onClick={() => setDismissed(true)}>
          <X className="size-4" />
        </Button>
      </header>
      <ol className="mt-4 grid gap-1.5 md:grid-cols-2">
        {steps.map((step) => (
          <li key={step.title}>
            <Link
              to={step.to}
              params={{ orgId: org.id }}
              className={cn(
                "group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-hairline hover:bg-surface-2",
                step === next && "border-accent/30 bg-accent-soft",
              )}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border",
                  step.done ? "border-won bg-won-soft text-won" : "border-hairline-strong text-transparent",
                )}
              >
                <Check className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-medium", step.done && "text-muted line-through decoration-hairline-strong")}>
                  {step.title}
                  <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                </span>
                {step.done ? null : <span className="block text-[0.8125rem] text-muted">{step.why}</span>}
              </span>
              {step.done ? null : <ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
