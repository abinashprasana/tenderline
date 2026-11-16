import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, GripVertical, Inbox, KanbanSquare } from "lucide-react";
import { motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ApiError, describeError } from "@/api/errors";
import { useOpportunities, useSetStatus, type Opportunity } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { MenuContent, MenuItem } from "@/app/shell";
import { DeadlineChip } from "@/components/deadline-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { STATUS_LABEL } from "@/lib/format";
import { SCREEN } from "@/lib/labels";
import { EmptyBoard } from "@/components/illustrations";

export const STATUSES = ["new", "bid", "submitted", "won", "no_bid", "lost"] as const;

const COLUMN_HINT: Record<string, string> = {
  new: "Tracked, not yet decided",
  bid: "Preparing a response",
  submitted: "Waiting for the award",
  won: "Awarded to you",
  no_bid: "Decided not to bid",
  lost: "Awarded to someone else",
};

const COLUMN_EMPTY: Record<string, string> = {
  new: "Tenders you start tracking appear here.",
  bid: "Drag a tender here when you decide to bid.",
  submitted: "Drag here once your response is sent.",
  won: "Awarded to you. Filled in from the award notice.",
  no_bid: "Tenders you decided to pass on.",
  lost: "Awarded to someone else.",
};

const COLUMN_DOT: Record<string, string> = {
  new: "bg-info",
  bid: "bg-accent",
  submitted: "bg-soon",
  won: "bg-won",
  no_bid: "bg-faint",
  lost: "bg-lost",
};

export function OpportunityBoard() {
  const org = useOrg();
  const canWrite = useCan("write");
  const list = useOpportunities(org.id);
  const setStatus = useSetStatus(org.id);
  // Moves the server has not confirmed yet. If it refuses, the override is dropped and the card slides back.
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState<Opportunity | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const items = (list.data?.items ?? []).map((o) => (moves[o.id] ? { ...o, status: moves[o.id]! } : o));

  async function move(opportunity: Opportunity, status: string) {
    if (status === opportunity.status) return;
    if (!opportunity.allowed_transitions.includes(status)) {
      toast.error(`${STATUS_LABEL[opportunity.status]} can only move to ${listOf(opportunity.allowed_transitions)}.`);
      return;
    }
    setMoves((current) => ({ ...current, [opportunity.id]: status }));
    try {
      await setStatus.mutateAsync({ id: opportunity.id, status });
      toast.success(`Moved to ${STATUS_LABEL[status]}`);
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.code === "invalid_transition"
          ? "Someone changed this opportunity meanwhile. It is back where the server has it."
          : describeError(error),
      );
    } finally {
      setMoves(({ [opportunity.id]: _, ...rest }) => rest);
    }
  }

  const onDragStart = (event: DragStartEvent) => setDragging(items.find((o) => o.id === event.active.id) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    const opportunity = items.find((o) => o.id === event.active.id);
    setDragging(null);
    if (opportunity && event.over) void move(opportunity, String(event.over.id));
  };

  return (
    <>
      <PageHeader
        title={SCREEN.pipeline}
        description={
          canWrite
            ? "The tenders you are tracking. Drag a card, or use its move button, when something changes."
            : "The tenders your team is tracking. Bid managers and owners move them."
        }
        intro={{
          id: "pipeline",
          text: "A tender enters the pipeline when you approve “Track in the pipeline” or track a notice yourself. It then moves left to right as you decide, bid and hear back.",
          points: [
            { icon: <KanbanSquare className="size-4" />, title: "New → Bidding", body: "Decide whether to bid. Not for you? Move it to No bid." },
            { icon: <ArrowRightLeft className="size-4" />, title: "Only valid moves", body: "While you drag, columns a card cannot go to fade out." },
            { icon: <Inbox className="size-4" />, title: "Award notices", body: "When the buyer publishes the award, Won or Lost is recorded for you." },
          ],
        }}
      />
      {list.isPending ? (
        <SkeletonRows rows={4} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <div className="panel">
          <EmptyState
            illustration={<EmptyBoard />}
            title="Your pipeline is empty"
            action={
              <Button asChild variant="primary">
                <Link to="/o/$orgId/approvals" params={{ orgId: org.id }}>
                  Open To decide
                </Link>
              </Button>
            }
          >
            Approve a “Track in the pipeline” suggestion in To decide, or open any notice and choose “Track this notice”.
          </EmptyState>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
            <div data-wren-target="pipeline-board" data-perch-x="120" className="grid min-w-[72rem] grid-cols-6 items-start gap-3">
              {STATUSES.map((status) => {
                const cards = items.filter((o) => o.status === status);
                const allowed = dragging ? dragging.status === status || dragging.allowed_transitions.includes(status) : true;
                return (
                  <Column key={status} status={status} count={cards.length} dimmed={!allowed} disabled={!canWrite || !allowed}>
                    {cards.map((opportunity) => (
                      <Card key={opportunity.id} opportunity={opportunity} canWrite={canWrite} onMove={move} />
                    ))}
                    {cards.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-hairline-strong px-3 py-6 text-center text-xs text-muted">{COLUMN_EMPTY[status]}</p>
                    ) : null}
                  </Column>
                );
              })}
            </div>
          </div>
          <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>
            {dragging ? <CardBody opportunity={dragging} lifted /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </>
  );
}

function listOf(statuses: string[]): string {
  if (statuses.length === 0) return "nothing (it is closed)";
  return statuses.map((s) => STATUS_LABEL[s] ?? s).join(" or ");
}

function Column({
  status,
  count,
  dimmed,
  disabled,
  children,
}: {
  status: string;
  count: number;
  dimmed: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STATUS_LABEL[status]}: ${count}`}
      className={cn(
        "flex min-h-48 flex-col rounded-xl border border-hairline bg-surface/40 p-2 transition-[opacity,border-color,background-color] duration-200",
        dimmed && "opacity-35",
        isOver && !disabled && "border-accent/60 bg-accent-soft",
      )}
    >
      <header className="flex items-center gap-2 px-2 pt-1 pb-2">
        <span className={cn("size-2 rounded-full", COLUMN_DOT[status])} aria-hidden />
        <h2 className="text-sm font-medium">{STATUS_LABEL[status]}</h2>
        <span className="tabular ml-auto font-mono text-xs text-muted">{count}</span>
      </header>
      <p className="px-2 pb-2 text-xs text-muted">{COLUMN_HINT[status]}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Card({
  opportunity,
  canWrite,
  onMove,
}: {
  opportunity: Opportunity;
  canWrite: boolean;
  onMove: (opportunity: Opportunity, status: string) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opportunity.id,
    disabled: !canWrite || opportunity.allowed_transitions.length === 0,
  });
  return (
    <motion.div layout layoutId={opportunity.id} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }} className={cn(isDragging && "opacity-30")}>
      <CardBody
        opportunity={opportunity}
        handle={
          canWrite && opportunity.allowed_transitions.length > 0 ? (
            <div className="flex items-center">
              <button
                ref={setNodeRef}
                {...listeners}
                {...attributes}
                aria-label={`Drag ${opportunity.notice_title}`}
                className="grid size-7 cursor-grab touch-none place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-text active:cursor-grabbing"
              >
                <GripVertical className="size-4" />
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    aria-label={`Move ${opportunity.notice_title}`}
                    className="flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-surface-3 hover:text-text"
                  >
                    <ArrowRightLeft className="size-3.5" /> Move
                  </button>
                </DropdownMenu.Trigger>
                <MenuContent align="end">
                  <DropdownMenu.Label className="px-2 py-1.5 text-xs text-faint">Move to</DropdownMenu.Label>
                  {opportunity.allowed_transitions.map((status) => (
                    <MenuItem key={status} onSelect={() => void onMove(opportunity, status)}>
                      <span className={cn("size-2 rounded-full", COLUMN_DOT[status])} aria-hidden />
                      {STATUS_LABEL[status]}
                    </MenuItem>
                  ))}
                </MenuContent>
              </DropdownMenu.Root>
            </div>
          ) : null
        }
      />
    </motion.div>
  );
}

function CardBody({ opportunity, handle, lifted }: { opportunity: Opportunity; handle?: ReactNode; lifted?: boolean }) {
  const org = useOrg();
  const flagged = Boolean(opportunity.flags?.notice_changed) || Boolean(opportunity.flags?.outcome_needs_review);
  return (
    <article className={cn("panel group p-3", lifted && "rotate-[1.5deg] shadow-2xl ring-1 ring-accent/40")}>
      <Link
        to="/o/$orgId/opportunities/$oppId"
        params={{ orgId: org.id, oppId: opportunity.id }}
        className="line-clamp-3 text-sm leading-snug font-medium hover:text-accent"
      >
        {opportunity.notice_title || "Untitled notice"}
      </Link>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {opportunity.next_deadline ? <DeadlineChip at={opportunity.next_deadline.due_at} /> : null}
        {opportunity.pending_proposals > 0 ? (
          <Badge tone="agent" icon={<Inbox className="size-3" />}>
            {opportunity.pending_proposals}
            <span className="sr-only"> proposals waiting</span>
          </Badge>
        ) : null}
        {flagged ? <Badge tone="soon">Check</Badge> : null}
        {handle ? <div className="-mr-1.5 -mb-1 ml-auto">{handle}</div> : null}
      </div>
    </article>
  );
}
