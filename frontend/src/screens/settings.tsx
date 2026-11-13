import { Trash2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";

import { ApiError, describeError } from "@/api/errors";
import {
  useAddMember,
  useChangeRole,
  useMembers,
  useOrgDetails,
  usePatchOrg,
  useRemoveMember,
  type Member,
  type OrgProfile,
} from "@/api/hooks";
import { useCan, useOrg } from "@/app/org";
import { useSession } from "@/auth/use-session";
import { TagInput } from "@/components/tag-input";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { ErrorState, PageHeader, SkeletonRows } from "@/components/ui/states";
import { resetTips } from "@/lib/first-run";
import { NEED, ROLE_LABEL, ROLES, type Role } from "@/lib/permissions";
import { setReducedTransparency, setTheme, useReducedTransparency, useTheme } from "@/lib/theme";

const TIMEZONES = ["Europe/Dublin", "Europe/London", "Europe/Brussels", "Europe/Paris", "Europe/Berlin", "UTC"];

export function Settings() {
  const org = useOrg();
  const isAdmin = useCan("admin");
  const details = useOrgDetails(org.id);
  return (
    <>
      <PageHeader title="Settings" description={isAdmin ? "Company profile, timezone and members." : `${NEED.admin} You can see the current values.`} />
      {details.isPending ? (
        <SkeletonRows rows={4} />
      ) : details.isError ? (
        <ErrorState error={details.error} onRetry={() => void details.refetch()} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ProfileForm key={details.data.id + details.data.name} initialName={details.data.name} initialTimezone={details.data.timezone} profile={details.data.profile as OrgProfile} readOnly={!isAdmin} />
          <MembersPanel readOnly={!isAdmin} />
          <Preferences />
        </div>
      )}
    </>
  );
}

/** What the assistant gets from each part of the profile, and how much of it is filled in. */
const PROFILE_PARTS: { key: keyof OrgProfile; label: string; why: string }[] = [
  { key: "description", label: "What you do", why: "the main thing it compares each notice against" },
  { key: "capabilities", label: "Capabilities", why: "named skills it looks for in the notice" },
  { key: "certifications", label: "Certifications", why: "so it can flag tenders that require one you lack" },
  { key: "regions", label: "Regions", why: "to spot work outside where you deliver" },
  { key: "min_contract_value", label: "Contract size", why: "to flag tenders too small or too large for you" },
];

function filled(form: OrgProfile, key: keyof OrgProfile): boolean {
  if (key === "min_contract_value") return form.min_contract_value != null || form.max_contract_value != null;
  const value = form[key];
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length >= 20 : value != null;
}

function ProfileMeter({ form }: { form: OrgProfile }) {
  const done = PROFILE_PARTS.filter((part) => filled(form, part.key));
  const missing = PROFILE_PARTS.filter((part) => !filled(form, part.key));
  const pct = Math.round((done.length / PROFILE_PARTS.length) * 100);
  return (
    <div className="rounded-lg border border-hairline bg-surface-2 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Profile {pct === 100 ? "complete" : `${pct}% complete`}</span>
        <span className="tabular font-mono text-xs text-muted">
          {done.length}/{PROFILE_PARTS.length}
        </span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Profile completeness">
        <motion.div
          className="h-full rounded-full bg-accent"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      {missing.length ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted">
          {missing.slice(0, 3).map((part) => (
            <li key={part.key}>
              Add <span className="text-text">{part.label.toLowerCase()}</span>: {part.why}.
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">The assistant has everything it uses.</p>
      )}
    </div>
  );
}

function ProfileForm({ initialName, initialTimezone, profile, readOnly }: { initialName: string; initialTimezone: string | null; profile: OrgProfile; readOnly: boolean }) {
  const org = useOrg();
  const patch = usePatchOrg(org.id);
  const [name, setName] = useState(initialName);
  const [timezone, setTimezone] = useState(initialTimezone ?? "Europe/Dublin");
  const [form, setForm] = useState<OrgProfile>({
    description: profile.description ?? "",
    capabilities: profile.capabilities ?? [],
    regions: profile.regions ?? [],
    certifications: profile.certifications ?? [],
    min_contract_value: profile.min_contract_value ?? null,
    max_contract_value: profile.max_contract_value ?? null,
  });
  const set = <K extends keyof OrgProfile>(key: K, value: OrgProfile[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await patch.mutateAsync({ name: name.trim(), timezone, profile: form });
    toast.success("Profile saved. The assistant uses it from its next assessment.");
  };

  return (
    <form onSubmit={(e) => void submit(e).catch(() => {})} className="panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-medium">Company profile</h2>
        <p className="text-sm text-muted">The assistant reads this to judge whether a tender fits. Plain, specific words work best.</p>
      </div>
      <ProfileMeter form={form} />
      <fieldset disabled={readOnly} className="flex flex-col gap-4">
        <Field label="Company name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={200} required />}</Field>
        <Field label="What you do">{(p) => <Textarea {...p} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={2000} />}</Field>
        <Field label="Capabilities">{(p) => <TagInput {...p} value={form.capabilities ?? []} onChange={(v) => set("capabilities", v)} placeholder="managed IT, cloud…" />}</Field>
        <Field label="Certifications">{(p) => <TagInput {...p} value={form.certifications ?? []} onChange={(v) => set("certifications", v)} placeholder="ISO 27001…" />}</Field>
        <Field label="Regions you deliver in" hint="Country codes (IRL) or regions, as you would describe them.">
          {(p) => <TagInput {...p} value={form.regions ?? []} onChange={(v) => set("regions", v)} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Smallest contract (€)">
            {(p) => <Input {...p} type="number" min={0} value={form.min_contract_value ?? ""} onChange={(e) => set("min_contract_value", e.target.value === "" ? null : Number(e.target.value))} />}
          </Field>
          <Field label="Largest contract (€)">
            {(p) => <Input {...p} type="number" min={0} value={form.max_contract_value ?? ""} onChange={(e) => set("max_contract_value", e.target.value === "" ? null : Number(e.target.value))} />}
          </Field>
        </div>
        <Field label="Timezone" hint="Reminders are shown in this timezone.">
          {(p) => (
            <Select {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </Select>
          )}
        </Field>
      </fieldset>
      {readOnly ? null : (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={patch.isPending}>
            Save profile
          </Button>
        </div>
      )}
    </form>
  );
}

/** Per-browser preferences. Nothing here is stored on the server. */
function Preferences() {
  const theme = useTheme();
  const reduced = useReducedTransparency();
  return (
    <section className="panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-medium">Your preferences</h2>
        <p className="text-sm text-muted">Saved in this browser only.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">Theme</span>
        <div className="flex rounded-full border border-hairline bg-surface-2 p-0.5" role="group" aria-label="Theme">
          {(["dark", "light"] as const).map((t) => (
            <button
              key={t}
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
              className="h-8 rounded-full px-4 text-sm text-muted capitalize transition-colors aria-pressed:bg-surface-3 aria-pressed:text-text"
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Reduce transparency
          <span className="block text-xs text-muted">Solid panels instead of frosted glass.</span>
        </span>
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={reduced} onChange={(e) => setReducedTransparency(e.target.checked)} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          Tips and introductions
          <span className="block text-xs text-muted">Show the getting-started list and every page introduction again.</span>
        </span>
        <Button
          size="sm"
          onClick={() => {
            resetTips();
            toast.success("Tips are back. You will see them as you move around.");
          }}
        >
          Show tips again
        </Button>
      </div>
    </section>
  );
}

function MembersPanel({ readOnly }: { readOnly: boolean }) {
  const org = useOrg();
  const members = useMembers(org.id);
  const add = useAddMember(org.id);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("reviewer");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({ login: login.trim(), role });
      toast.success(`${login.trim()} added`);
      setLogin("");
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "not_found" ? "No one with that GitHub login has signed in to Tenderline yet. Ask them to sign in once, then add them." : describeError(caught));
    }
  };

  return (
    <section className="panel flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-medium">Members</h2>
        <p className="text-sm text-muted">Viewers can look. Reviewers can also decide suggestions. Bid managers can also change watchlists and the pipeline. Owners can do everything, including this page.</p>
      </div>
      {members.isPending ? (
        <SkeletonRows rows={3} />
      ) : (
        <ul className="divide-y divide-hairline">
          {(members.data ?? []).map((member) => (
            <MemberRow key={member.user_id} member={member} readOnly={readOnly} />
          ))}
        </ul>
      )}
      {readOnly ? null : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 border-t border-hairline pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="GitHub login" className="min-w-40 flex-1" error={error ?? undefined}>
              {(p) => <Input {...p} value={login} onChange={(e) => setLogin(e.target.value)} required maxLength={100} />}
            </Field>
            <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-36">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <Button type="submit" pending={add.isPending}>
              <UserPlus className="size-4" /> Add
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function MemberRow({ member, readOnly }: { member: Member; readOnly: boolean }) {
  const org = useOrg();
  const session = useSession();
  const change = useChangeRole(org.id);
  const remove = useRemoveMember(org.id);
  const role = change.isPending && change.variables ? change.variables.role : member.role;
  const isMe = session?.userId === member.user_id;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="grid size-8 place-items-center rounded-full bg-surface-3 text-sm font-semibold">{member.login.slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {member.name ?? member.login} {isMe ? <span className="text-faint">(you)</span> : null}
        </span>
        <span className="block text-xs text-faint">{member.login}</span>
      </span>
      {readOnly ? (
        <span className="text-sm text-muted">{ROLE_LABEL[member.role as Role] ?? member.role}</span>
      ) : (
        <>
          <Select
            aria-label={`Role for ${member.login}`}
            value={role}
            className="w-36"
            disabled={change.isPending}
            onChange={(e) => change.mutate({ userId: member.user_id, role: e.target.value }, { onSuccess: () => toast.success("Role changed") })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${member.login}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate(member.user_id, { onSuccess: () => toast(`${member.login} removed`) })}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
    </li>
  );
}
