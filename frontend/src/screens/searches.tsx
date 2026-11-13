import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";

import { api, unwrap } from "@/api/client";
import { describeError, fieldErrors } from "@/api/errors";
import {
  cleanParams,
  useCreateSearch,
  useDeleteSearch,
  useMatches,
  usePatchSearch,
  useReplaceSearch,
  useSearches,
  type SavedSearch,
  type SearchInput,
} from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { CpvChip, CpvPicker } from "@/components/cpv-picker";
import { Ago } from "@/components/deadline-chip";
import { Watching } from "@/components/illustrations";
import { TagInput } from "@/components/tag-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { money } from "@/lib/format";
import { plural, SCREEN } from "@/lib/labels";
import type { WatchlistPrefill } from "@/router";
import { NEED } from "@/lib/permissions";

const EMPTY: SearchInput = { name: "", cpv_codes: [], keywords: [], buyer_names: [], countries: ["IRL"], min_value: null, max_value: null, active: true };

function hasCriterion(s: SearchInput): boolean {
  return Boolean(s.cpv_codes?.length || s.keywords?.length || s.buyer_names?.length || s.countries?.length || s.min_value || s.max_value);
}

export function SavedSearches() {
  const org = useOrg();
  const canWrite = useCan("write");
  const searches = useSearches(org.id);
  const prefill = useSearch({ from: "/o/$orgId/searches" });
  const navigate = useNavigate({ from: "/o/$orgId/searches" });
  const matches = useMatches(org.id, {});
  const [editing, setEditing] = useState<SavedSearch | "new" | null>(null);
  // "?create" opens the builder: from the palette, the Notices screen, or a shared link, also when this
  // page is already open. Adjusting state during render keeps this out of an effect.
  const [handledCreate, setHandledCreate] = useState(false);
  if (Boolean(prefill.create) !== handledCreate) {
    setHandledCreate(Boolean(prefill.create));
    if (prefill.create && canWrite) setEditing("new");
  }
  const closeBuilder = () => {
    setEditing(null);
    if (prefill.create) void navigate({ search: {}, replace: true });
  };
  const matchCount = (id: string) => matches.data?.items.filter((m) => m.saved_search_id === id).length;

  return (
    <>
      <PageHeader
        title={SCREEN.watchlists}
        description="What Tenderline watches for on your behalf. Every new notice is checked against these; matches go to the assistant, then to you."
        intro={{
          id: "watchlists",
          text: "A watchlist is a set of rules. A notice matches when it meets every rule you filled in. Start broad (one category and your country) and narrow it if too much arrives.",
        }}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> New watchlist
            </Button>
          ) : null
        }
      />
      {searches.isPending ? (
        <SkeletonRows rows={3} />
      ) : searches.isError ? (
        <ErrorState error={searches.error} onRetry={() => void searches.refetch()} />
      ) : searches.data.items.length === 0 ? (
        <div className="panel">
          <EmptyState
            illustration={<Watching />}
            title="Nothing is being watched yet"
            action={canWrite ? <Button variant="primary" onClick={() => setEditing("new")}>Create your first</Button> : undefined}
          >
            {canWrite
              ? "Start broad: one category (for example IT services) and your country. You can narrow it later."
              : NEED.write}
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {searches.data.items.map((s) => (
            <SearchCard key={s.id} search={s} canWrite={canWrite} onEdit={() => setEditing(s)} matched={matchCount(s.id)} />
          ))}
        </ul>
      )}
      {editing ? <Builder key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} prefill={editing === "new" ? prefill : undefined} onClose={closeBuilder} /> : null}
    </>
  );
}

function SearchCard({ search, canWrite, onEdit, matched }: { search: SavedSearch; canWrite: boolean; onEdit: () => void; matched: number | undefined }) {
  const org = useOrg();
  const patch = usePatchSearch(org.id);
  const remove = useDeleteSearch(org.id);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="panel flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{search.name}</h2>
          <p className="text-xs text-muted">
            {matched === undefined ? "Counting matches…" : matched >= 200 ? "200+ notices matched" : `${plural(matched, "notice")} matched`} · created <Ago at={search.created_at} />
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <span>{search.active ? "Active" : "Paused"}</span>
          <input
            type="checkbox"
            role="switch"
            checked={search.active}
            disabled={!canWrite || patch.isPending}
            onChange={(e) => patch.mutate({ id: search.id, active: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative h-5 w-9 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-text after:transition-transform peer-checked:after:translate-x-4 peer-checked:after:bg-accent-fg"
          />
        </label>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        {(search.cpv_codes ?? []).map((code) => (
          <CpvChip key={code} code={code} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(search.keywords ?? []).map((k) => (
          <Badge key={k}>“{k}”</Badge>
        ))}
        {(search.buyer_names ?? []).map((b) => (
          <Badge key={b} tone="info">
            {b}
          </Badge>
        ))}
        {(search.countries ?? []).map((c) => (
          <Badge key={c} className="font-mono">
            {c}
          </Badge>
        ))}
        {search.min_value || search.max_value ? (
          <Badge tone="accent">
            {search.min_value ? money(search.min_value, "EUR") : "€0"} – {search.max_value ? money(search.max_value, "EUR") : "any"}
          </Badge>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <Button asChild size="sm" variant="ghost">
          <Link to="/o/$orgId/matches" params={{ orgId: org.id }} search={{ search: search.id }}>
            See matched notices
          </Link>
        </Button>
        {canWrite ? (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete the watchlist “${search.name}”?`}
        description="New notices stop being checked against it. Existing matches and proposals stay."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              pending={remove.isPending}
              onClick={() => remove.mutate(search.id, { onSuccess: () => toast("Watchlist deleted") })}
            >
              Delete
            </Button>
          </>
        }
      />
    </li>
  );
}

function Builder({ initial, prefill, onClose }: { initial: SavedSearch | null; prefill?: WatchlistPrefill; onClose: () => void }) {
  const org = useOrg();
  const create = useCreateSearch(org.id);
  const replace = useReplaceSearch(org.id);
  const [form, setForm] = useState<SearchInput>(
    initial
      ? {
          name: initial.name,
          cpv_codes: initial.cpv_codes ?? [],
          keywords: initial.keywords ?? [],
          buyer_names: initial.buyer_names ?? [],
          countries: initial.countries ?? [],
          min_value: initial.min_value ?? null,
          max_value: initial.max_value ?? null,
          active: initial.active,
        }
      : prefill?.create
        ? {
            ...EMPTY,
            cpv_codes: prefill.cpv ? [prefill.cpv] : [],
            keywords: prefill.q ? [prefill.q] : [],
            countries: prefill.country ? [prefill.country] : EMPTY.countries,
            min_value: prefill.min_value ?? null,
            max_value: prefill.max_value ?? null,
          }
        : EMPTY,
  );
  const set = <K extends keyof SearchInput>(key: K, value: SearchInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const error = create.error ?? replace.error;
  const errors = fieldErrors(error);
  const min = form.min_value === null || form.min_value === undefined || form.min_value === "" ? null : Number(form.min_value);
  const max = form.max_value === null || form.max_value === undefined || form.max_value === "" ? null : Number(form.max_value);
  const rangeBad = min !== null && max !== null && min > max;
  const ready = form.name.trim().length > 0 && hasCriterion(form) && !rangeBad;

  const save = async () => {
    const body: SearchInput = { ...form, name: form.name.trim(), min_value: min, max_value: max };
    if (initial) {
      await replace.mutateAsync({ id: initial.id, body });
      toast.success("Watchlist updated");
    } else {
      await create.mutateAsync(body);
      toast.success("Watchlist saved. Open notices are being checked now; suggestions appear in To decide within a minute.");
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? "Edit watchlist" : "New watchlist"}
      description="A notice matches when it meets every rule you fill in. Leave a rule empty to ignore it."
      className="w-[min(calc(100vw-2rem),38rem)]"
      footer={
        <>
          {error && !Object.keys(errors).length ? <p className="mr-auto self-center text-sm text-lost">{describeError(error)}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} pending={create.isPending || replace.isPending} onClick={() => void save().catch(() => {})}>
            {initial ? "Save changes" : "Create"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" error={errors.name}>
          {(props) => <Input {...props} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} placeholder="e.g. Managed IT, Leinster" autoFocus />}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium text-muted">What is being bought: categories (CPV)</span>
          <CpvPicker value={form.cpv_codes ?? []} onChange={(codes) => set("cpv_codes", codes)} />
          {errors.cpv_codes ? <p className="text-xs text-lost">{errors.cpv_codes}</p> : null}
        </div>
        <Field label="Keywords in title or description" hint="Any one keyword is enough." error={errors.keywords}>
          {(props) => <TagInput {...props} value={form.keywords ?? []} onChange={(v) => set("keywords", v)} placeholder="cloud, cyber security…" />}
        </Field>
        <Field label="Buyers" hint="Part of the buyer's name, e.g. HSE or County Council." error={errors.buyer_names}>
          {(props) => <TagInput {...props} value={form.buyer_names ?? []} onChange={(v) => set("buyer_names", v)} />}
        </Field>
        <Field label="Countries" hint="Three-letter codes: IRL, GBR, FRA…" error={errors.countries}>
          {(props) => (
            <TagInput
              {...props}
              value={form.countries ?? []}
              onChange={(v) => set("countries", v)}
              normalise={(t) => t.trim().toUpperCase()}
              validate={(t) => /^[A-Z]{3}$/.test(t)}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum value (€)" error={errors.min_value}>
            {(props) => <Input {...props} type="number" min={0} inputMode="numeric" value={form.min_value ?? ""} onChange={(e) => set("min_value", e.target.value === "" ? null : e.target.value)} />}
          </Field>
          <Field label="Maximum value (€)" error={rangeBad ? "Must be at least the minimum." : errors.max_value}>
            {(props) => <Input {...props} type="number" min={0} inputMode="numeric" value={form.max_value ?? ""} onChange={(e) => set("max_value", e.target.value === "" ? null : e.target.value)} />}
          </Field>
        </div>
        {!hasCriterion(form) ? <p className="text-xs text-soon">Add at least one rule.</p> : <MatchEstimate form={form} />}
      </div>
    </Dialog>
  );
}

/**
 * "About N open notices match": asks the notices list with the same categories, country and value range.
 * Several categories are counted one by one and added up, so overlapping codes can count a notice twice;
 * keywords and buyers narrow the real result further, which the text says.
 */
function MatchEstimate({ form }: { form: SearchInput }) {
  const codes = useDeferredValue((form.cpv_codes ?? []).slice(0, 5));
  const country = (form.countries ?? []).length === 1 ? form.countries![0] : undefined;
  const min = form.min_value === null || form.min_value === undefined || form.min_value === "" ? undefined : Number(form.min_value);
  const max = form.max_value === null || form.max_value === undefined || form.max_value === "" ? undefined : Number(form.max_value);
  const [today] = useState(() => new Date().toISOString());
  const queries = useQueries({
    queries: (codes.length ? codes : [undefined]).map((cpv) => ({
      queryKey: ["estimate", cpv, country, min, max],
      staleTime: 60_000,
      queryFn: () =>
        unwrap(
          api.GET("/v1/notices", {
            params: {
              query: cleanParams({ cpv, country, min_value: min, max_value: max, status: "open", deadline_after: today, limit: 200 }),
            },
          }),
        ),
    })),
  });
  if (queries.some((q) => q.isPending)) return <p className="text-xs text-muted">Counting open notices…</p>;
  if (queries.some((q) => q.isError)) return null;
  const total = queries.reduce((sum, q) => sum + (q.data?.items.length ?? 0), 0);
  const capped = queries.some((q) => q.data?.next_cursor);
  const narrower = (form.keywords ?? []).length > 0 || (form.buyer_names ?? []).length > 0 || (form.countries ?? []).length > 1;
  return (
    <p className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-sm" role="status">
      About <span className="tabular font-mono font-semibold">{capped ? `${total}+` : total}</span> open{" "}
      {total === 1 ? "notice matches" : "notices match"} these categories{country ? ` in ${country}` : ""} right now
      {narrower ? ", before keywords and buyers narrow it down" : ""}.
      {total === 0 ? " Try a broader category." : ""}
    </p>
  );
}
