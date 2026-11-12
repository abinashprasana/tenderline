import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BellPlus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useNotices, type Notice } from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { NoResults } from "@/components/illustrations";
import { CpvPicker } from "@/components/cpv-picker";
import { DeadlineChip } from "@/components/deadline-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { date, moneyShort, number } from "@/lib/format";
import { SCREEN } from "@/lib/labels";
import type { NoticeSearch } from "@/router";

import { NoticeDrawer } from "./drawer";

const ROW = 64;

export function NoticeExplorer() {
  const org = useOrg();
  const canWrite = useCan("write");
  const search = useSearch({ from: "/o/$orgId/notices" });
  const navigate = useNavigate({ from: "/o/$orgId/notices" });
  const { notice: openNotice, ...filters } = search;
  // "Deadline soonest" means upcoming deadlines; closed notices would otherwise fill the top of the list.
  const [today] = useState(() => new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
  const query = useNotices(filters.sort === "deadline" && !filters.deadline_after ? { ...filters, deadline_after: today } : filters);
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const [showFilters, setShowFilters] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 8 });
  const items = virtual.getVirtualItems();
  const last = items.at(-1);

  // Load the next page as the list nears its end (cursor pagination).
  useEffect(() => {
    if (last && last.index >= rows.length - 10 && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [last, rows.length, query]);

  const setFilters = (next: Partial<NoticeSearch>) => void navigate({ search: (prev) => ({ ...prev, ...next, notice: undefined }) });
  const active = Object.entries(filters).filter(([key, value]) => value !== undefined && key !== "sort");

  return (
    <>
      <PageHeader
        title={SCREEN.notices}
        description="Everything collected from TED and eTenders, whether or not it matches a watchlist. The link keeps your filters, so you can share a view."
        intro={{
          id: "notices",
          text: "Use this to explore beyond your watchlists. When a set of filters looks useful, turn it into a watchlist and Tenderline will bring you new notices like these.",
        }}
        actions={
          <>
            {canWrite && (filters.cpv || filters.q || filters.country || filters.min_value || filters.max_value) ? (
              <Button asChild size="sm" variant="primary">
                <Link
                  to="/o/$orgId/searches"
                  params={{ orgId: org.id }}
                  search={{ create: true, cpv: filters.cpv, q: filters.q, country: filters.country, min_value: filters.min_value, max_value: filters.max_value }}
                >
                  <BellPlus className="size-3.5" /> Watch for notices like these
                </Link>
              </Button>
            ) : null}
            <Button size="sm" className="lg:hidden" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              <SlidersHorizontal className="size-3.5" /> Filters{active.length ? ` (${active.length})` : ""}
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        <aside className={cn("panel h-fit p-4 lg:sticky lg:top-20", !showFilters && "max-lg:hidden")} aria-label="Filters">
          <Filters value={filters} onChange={setFilters} />
        </aside>

        <section className="panel flex min-w-0 flex-col overflow-hidden" aria-label="Notices">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
            <p className="text-sm text-muted" aria-live="polite">
              {query.isPending ? "Loading…" : `${number(rows.length)}${query.hasNextPage ? "+" : ""} notices`}
            </p>
            {active.map(([key]) => (
              <Badge key={key} className="pr-1">
                {key.replace(/_/g, " ")}
                <button className="ml-1 grid size-4 place-items-center rounded-full hover:bg-surface-3" aria-label={`Clear ${key}`} onClick={() => setFilters({ [key]: undefined })}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <label className="ml-auto flex items-center gap-2 text-sm text-muted">
              Sort
              <Select
                value={filters.sort ?? "created"}
                onChange={(e) => setFilters({ sort: e.target.value === "created" ? undefined : (e.target.value as NoticeSearch["sort"]) })}
                className="h-8 w-auto"
              >
                <option value="created">Newest collected</option>
                <option value="published">Newest published</option>
                <option value="deadline">Deadline soonest</option>
              </Select>
            </label>
          </div>

          <div className="hidden grid-cols-[1fr_7rem_8rem_7rem_4rem] gap-4 border-b border-hairline px-4 py-2 text-xs text-faint md:grid">
            <span>Notice</span>
            <span className="text-right">Value</span>
            <span>Time left</span>
            <span>Published</span>
            <span>Country</span>
          </div>

          {query.isPending ? (
            <SkeletonRows rows={8} className="p-4" />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState illustration={<NoResults />} title="No notices match these filters">
              Loosen a filter, or look at Data sources to see when notices were last collected.
            </EmptyState>
          ) : (
            <div ref={scroller} className="h-[calc(100dvh-15rem)] min-h-96 overflow-y-auto" tabIndex={0} aria-label="Notice list, scrollable">
              <ul className="relative" style={{ height: virtual.getTotalSize() }}>
                {items.map((item) => {
                  const notice = rows[item.index]!;
                  return (
                    <li
                      key={notice.id}
                      className="absolute inset-x-0"
                      style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                    >
                      <Row notice={notice} active={notice.id === openNotice} onOpen={() => void navigate({ search: (prev) => ({ ...prev, notice: notice.id }) })} />
                    </li>
                  );
                })}
              </ul>
              {query.isFetchingNextPage ? <p className="py-3 text-center text-xs text-faint">Loading more…</p> : null}
            </div>
          )}
        </section>
      </div>
      <NoticeDrawer id={openNotice} onClose={() => void navigate({ search: (prev) => ({ ...prev, notice: undefined }) })} />
    </>
  );
}

function Row({ notice, active, onOpen }: { notice: Notice; active: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={cn(
        "grid h-full w-full grid-cols-[1fr_auto] items-center gap-x-4 border-b border-hairline px-4 text-left transition-colors md:grid-cols-[1fr_7rem_8rem_7rem_4rem]",
        active ? "bg-accent-soft" : "hover:bg-surface-2/70",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{notice.title}</span>
        <span className="block truncate text-xs text-faint">
          {notice.buyer_name ?? "Buyer not stated"}
          {notice.current_version > 1 ? ` · changed (v${notice.current_version})` : ""}
        </span>
      </span>
      <span className="tabular hidden text-right font-mono text-sm md:block">{moneyShort(notice.estimated_value, notice.currency)}</span>
      <span>
        <DeadlineChip at={notice.deadline_at} />
      </span>
      <span className="hidden text-sm text-muted md:block">{date(notice.publication_date)}</span>
      <span className="hidden font-mono text-xs text-muted md:block">{notice.country ?? "—"}</span>
    </button>
  );
}

function Filters({ value, onChange }: { value: Omit<NoticeSearch, "notice">; onChange: (next: Partial<NoticeSearch>) => void }) {
  const submitText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onChange({ q: String(data.get("q") ?? "").trim() || undefined, buyer: String(data.get("buyer") ?? "").trim() || undefined });
  };
  const commit = (name: "q" | "buyer", text: string) => {
    const next = text.trim() || undefined;
    if (next !== value[name]) onChange({ [name]: next });
  };
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submitText} className="flex flex-col gap-4">
        <Field label="Words in title or summary">
          {(props) => <Input {...props} key={value.q ?? ""} name="q" type="search" defaultValue={value.q ?? ""} onBlur={(e) => commit("q", e.target.value)} placeholder="e.g. cloud hosting" />}
        </Field>
        <Field label="Buyer">
          {(props) => <Input {...props} key={value.buyer ?? ""} name="buyer" defaultValue={value.buyer ?? ""} onBlur={(e) => commit("buyer", e.target.value)} placeholder="e.g. HSE" />}
        </Field>
        <button type="submit" hidden />
      </form>
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium text-muted">Category (CPV), including everything under it</span>
        <CpvPicker value={value.cpv ? [value.cpv] : []} onChange={(codes) => onChange({ cpv: codes[0] })} multiple={false} label="CPV code" />
      </div>
      <Field label="Status">
        {(props) => (
          <Select {...props} value={value.status ?? ""} onChange={(e) => onChange({ status: e.target.value || undefined })}>
            <option value="">Any</option>
            <option value="open">Open</option>
            <option value="cancelled">Cancelled</option>
            <option value="awarded">Awarded</option>
          </Select>
        )}
      </Field>
      <Field label="Country (ISO code)">
        {(props) => (
          <Input
            {...props}
            defaultValue={value.country ?? ""}
            key={value.country ?? ""}
            maxLength={3}
            placeholder="IRL"
            className="uppercase"
            onBlur={(e) => onChange({ country: e.target.value.trim().toUpperCase() || undefined })}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Min value (€)">
          {(props) => (
            <Input {...props} type="number" min={0} inputMode="numeric" defaultValue={value.min_value ?? ""} key={`min${value.min_value ?? ""}`} onBlur={(e) => onChange({ min_value: e.target.value ? Number(e.target.value) : undefined })} />
          )}
        </Field>
        <Field label="Max value (€)">
          {(props) => (
            <Input {...props} type="number" min={0} inputMode="numeric" defaultValue={value.max_value ?? ""} key={`max${value.max_value ?? ""}`} onBlur={(e) => onChange({ max_value: e.target.value ? Number(e.target.value) : undefined })} />
          )}
        </Field>
      </div>
      <Field label="Published on or after">
        {(props) => <Input {...props} type="date" value={value.published_from ?? ""} onChange={(e) => onChange({ published_from: e.target.value || undefined })} />}
      </Field>
      <Field label="Deadline on or after">
        {(props) => (
          <Input
            {...props}
            type="date"
            value={value.deadline_after?.slice(0, 10) ?? ""}
            onChange={(e) => onChange({ deadline_after: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : undefined })}
          />
        )}
      </Field>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          onChange({ q: undefined, buyer: undefined, cpv: undefined, status: undefined, country: undefined, min_value: undefined, max_value: undefined, published_from: undefined, deadline_after: undefined })
        }
      >
        Clear all filters
      </Button>
    </div>
  );
}
