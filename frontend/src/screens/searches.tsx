import { Link } from "@tanstack/react-router";
import { Bell, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { describeError, fieldErrors } from "@/api/errors";
import {
  useCreateSearch,
  useDeleteSearch,
  usePatchSearch,
  useReplaceSearch,
  useSearches,
  type SavedSearch,
  type SearchInput,
} from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { CpvChip, CpvPicker } from "@/components/cpv-picker";
import { TagInput } from "@/components/tag-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { money, relative } from "@/lib/format";
import { NEED } from "@/lib/permissions";

const EMPTY: SearchInput = { name: "", cpv_codes: [], keywords: [], buyer_names: [], countries: ["IRL"], min_value: null, max_value: null, active: true };

function hasCriterion(s: SearchInput): boolean {
  return Boolean(s.cpv_codes?.length || s.keywords?.length || s.buyer_names?.length || s.countries?.length || s.min_value || s.max_value);
}

export function SavedSearches() {
  const org = useOrg();
  const canWrite = useCan("write");
  const searches = useSearches(org.id);
  const [editing, setEditing] = useState<SavedSearch | "new" | null>(null);

  return (
    <>
      <PageHeader
        title="Saved searches"
        description="What to watch for. Every new notice is checked against these; matches go to the agent for an assessment."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> New saved search
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
            icon={<Bell className="size-5" />}
            title="No saved searches yet"
            action={canWrite ? <Button variant="primary" onClick={() => setEditing("new")}>Create your first</Button> : undefined}
          >
            {canWrite
              ? "Start broad: one CPV division (for example 72, IT services) and your country. You can narrow it later."
              : NEED.write}
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {searches.data.items.map((s) => (
            <SearchCard key={s.id} search={s} canWrite={canWrite} onEdit={() => setEditing(s)} />
          ))}
        </ul>
      )}
      {editing ? <Builder key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function SearchCard({ search, canWrite, onEdit }: { search: SavedSearch; canWrite: boolean; onEdit: () => void }) {
  const org = useOrg();
  const patch = usePatchSearch(org.id);
  const remove = useDeleteSearch(org.id);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="panel flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{search.name}</h2>
          <p className="text-xs text-faint">Created {relative(search.created_at)}</p>
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
            Matches
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
        title={`Delete “${search.name}”?`}
        description="New notices stop being checked against it. Existing matches and proposals stay."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              pending={remove.isPending}
              onClick={() => remove.mutate(search.id, { onSuccess: () => toast("Saved search deleted") })}
            >
              Delete
            </Button>
          </>
        }
      />
    </li>
  );
}

function Builder({ initial, onClose }: { initial: SavedSearch | null; onClose: () => void }) {
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
      toast.success("Saved search updated");
    } else {
      await create.mutateAsync(body);
      toast.success("Saved. Matching against open notices now; matches appear within a minute.");
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? "Edit saved search" : "New saved search"}
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
          <span className="text-[0.8125rem] font-medium text-muted">What is being bought (CPV)</span>
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
        {!hasCriterion(form) ? <p className="text-xs text-soon">Add at least one rule.</p> : null}
      </div>
    </Dialog>
  );
}
