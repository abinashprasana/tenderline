import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, FileSearch, Sparkles, UserCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { describeError, fieldErrors } from "@/api/errors";
import { useCreateOrg, useCreateSearch, useMatches, useSummary } from "@/api/hooks";
import { CpvPicker } from "@/components/cpv-picker";
import { Logo } from "@/components/logo";
import { TagInput } from "@/components/tag-input";
import { Term } from "@/components/term";
import { Button, Spinner } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/labels";
import { useNow } from "@/lib/use-now";

const EASE = [0.22, 1, 0.36, 1] as const;
const STEPS = ["Your company", "What to watch for", "Your first tenders"];

// Top-level CPV divisions most small Irish suppliers start from. The codes are the official division codes.
const STARTERS: { code: string; name: string }[] = [
  { code: "72000000", name: "IT services" },
  { code: "48000000", name: "Software" },
  { code: "79000000", name: "Business services" },
  { code: "71000000", name: "Engineering and design" },
  { code: "45000000", name: "Construction" },
  { code: "80000000", name: "Training" },
  { code: "85000000", name: "Health and social care" },
  { code: "90000000", name: "Cleaning and environment" },
];

const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function Welcome() {
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string | null>(null);

  return (
    <main className="app-backdrop grain grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-5 flex items-center justify-between">
          <Link to="/" aria-label="Tenderline home">
            <Logo />
          </Link>
          <ol className="flex items-center gap-2" aria-label="Setup progress">
            {STEPS.map((label, index) => (
              <li key={label} className="flex items-center gap-2" aria-current={index === step ? "step" : undefined}>
                <span
                  className={cn(
                    "grid size-6 place-items-center rounded-full border text-xs font-medium transition-colors duration-300",
                    index < step && "border-accent bg-accent text-accent-fg",
                    index === step && "border-accent text-accent",
                    index > step && "border-hairline-strong text-muted",
                  )}
                >
                  {index < step ? <Check className="size-3.5" aria-hidden /> : index + 1}
                </span>
                <span className={cn("hidden text-xs sm:block", index === step ? "text-text" : "text-muted")}>{label}</span>
                {index < STEPS.length - 1 ? <span className="h-px w-4 bg-hairline-strong" aria-hidden /> : null}
              </li>
            ))}
          </ol>
        </div>

        <div className="glass overflow-hidden rounded-2xl">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="p-7"
            >
              {step === 0 ? (
                <CompanyStep
                  onDone={(id) => {
                    setOrgId(id);
                    setStep(1);
                  }}
                />
              ) : step === 1 && orgId ? (
                <WatchStep orgId={orgId} onDone={() => setStep(2)} />
              ) : orgId ? (
                <FindingStep orgId={orgId} onBack={() => setStep(1)} />
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  );
}

function CompanyStep({ onDone }: { onDone: (orgId: string) => void }) {
  const create = useCreateOrg();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const errors = fieldErrors(create.error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const org = await create.mutateAsync({
      name: name.trim(),
      profile: { description: description.trim(), capabilities: splitList(capabilities), regions: ["IRL"] },
    });
    onDone(org.id);
  }

  return (
    <form onSubmit={(e) => void submit(e).catch(() => {})} className="flex flex-col gap-4">
      <Heading title="Tell us about your company">
        The <Term k="assistant">assistant</Term> reads this when it judges whether a tender suits you. Two honest sentences
        beat a sales pitch. You can change it later in Settings.
      </Heading>
      <Field label="Company name" error={errors.name}>
        {(props) => (
          <Input {...props} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={200} autoFocus />
        )}
      </Field>
      <Field
        label="What you do"
        hint="For example: Managed IT and cloud hosting for public bodies, with a 24/7 security team."
        error={errors.description}
      >
        {(props) => <Textarea {...props} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />}
      </Field>
      <Field label="What you are good at (optional)" hint="Separate with commas: cloud hosting, cyber security, managed IT">
        {(props) => <Input {...props} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" pending={create.isPending}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </form>
  );
}

function WatchStep({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const create = useCreateSearch(orgId);
  const [codes, setCodes] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const toggle = (code: string) =>
    setCodes((current) => (current.includes(code) ? current.filter((c) => c !== code) : [...current, code]));
  const ready = codes.length > 0 || keywords.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await create.mutateAsync({
      name: "My first watchlist",
      cpv_codes: codes,
      keywords,
      countries: ["IRL"],
      buyer_names: [],
      active: true,
    });
    onDone();
  }

  return (
    <form onSubmit={(e) => void submit(e).catch(() => {})} className="flex flex-col gap-5">
      <Heading title="What should Tenderline watch for?">
        Pick what you sell. Every new Irish notice in these <Term k="cpv">categories</Term> is brought to you, already
        assessed. Start broad; you can narrow it later.
      </Heading>
      <fieldset>
        <legend className="mb-2 text-[0.8125rem] font-medium text-muted">Common starting points</legend>
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((starter) => {
            const on = codes.includes(starter.code);
            return (
              <button
                key={starter.code}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(starter.code)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm transition-[background-color,border-color,transform] duration-150 active:scale-[0.97]",
                  on
                    ? "border-accent bg-accent-soft text-text"
                    : "border-hairline bg-surface-2 text-muted hover:border-hairline-strong hover:text-text",
                )}
              >
                {on ? <Check className="size-3.5 text-accent" aria-hidden /> : null}
                {starter.name}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium text-muted">Or search every category</span>
        <CpvPicker value={codes} onChange={setCodes} label="Categories" />
      </div>
      <Field label="Keywords (optional)" hint="A notice also has to contain one of these words, if you add any.">
        {(props) => <TagInput {...props} value={keywords} onChange={setKeywords} placeholder="cloud, cyber security…" />}
      </Field>
      {create.error ? <p className="text-sm text-lost">{describeError(create.error)}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">Country is set to Ireland. Change it under Watchlists.</p>
        <Button type="submit" variant="primary" disabled={!ready} pending={create.isPending}>
          Find my tenders <ArrowRight className="size-4" />
        </Button>
      </div>
    </form>
  );
}

/** Step 3 follows the real pipeline: notices matched, the assistant assessing them, suggestions ready. */
function FindingStep({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const summary = useSummary(orgId);
  const matches = useMatches(orgId, {});
  const now = useNow();
  const [startedAt] = useState(() => Date.now());

  // Ask again every two seconds while this step is on screen.
  useEffect(() => {
    const timer = window.setInterval(() => void queryClient.invalidateQueries({ queryKey: ["org", orgId] }), 2000);
    return () => window.clearInterval(timer);
  }, [queryClient, orgId]);

  const matched = matches.data?.items.length ?? 0;
  const assessed = matches.data?.items.filter((m) => m.qualified_at).length ?? 0;
  const ready = summary.data?.notices_awaiting_decision ?? 0;
  const nothingFound = matched === 0 && now - startedAt > 45_000;
  const stage = ready > 0 ? 3 : matched > 0 ? 2 : 1;

  const rows: { icon: ReactNode; title: string; detail: string; state: "done" | "active" | "waiting" }[] = [
    { icon: <Check className="size-4" />, title: "Watchlist saved", detail: "Tenderline will check every new notice against it.", state: "done" },
    {
      icon: <FileSearch className="size-4" />,
      title: matched > 0 ? `${plural(matched, "open notice")} match` : "Checking open notices",
      detail: matched >= 200 ? "Showing the first 200. That is a broad watchlist; you can narrow it any time." : "From TED and eTenders, already collected.",
      state: stage > 1 ? "done" : "active",
    },
    {
      icon: <Sparkles className="size-4" />,
      title: assessed > 0 ? `The assistant has assessed ${assessed}` : "The assistant reads each match",
      detail: "It scores the fit and suggests what to do. It cannot act on its own.",
      state: stage > 2 ? "done" : stage === 2 ? "active" : "waiting",
    },
    {
      icon: <UserCheck className="size-4" />,
      title: ready > 0 ? `${plural(ready, "notice")} ready for your decision` : "Then it is your call",
      detail: "Approve, edit or reject each suggestion.",
      state: stage === 3 ? "active" : "waiting",
    },
  ];

  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      <Heading title={ready > 0 ? "Your first tenders are ready" : "Finding your tenders"}>
        {ready > 0 ? "More will keep arriving in the background while you look at the first ones." : "This usually takes under a minute."}
      </Heading>
      <ol className="relative flex flex-col gap-4">
        <span className="absolute top-4 bottom-4 left-[15px] w-px bg-hairline-strong" aria-hidden />
        {rows.map((row) => (
          <li key={row.detail} className="relative flex gap-4">
            <span
              className={cn(
                "z-10 grid size-8 shrink-0 place-items-center rounded-full border transition-colors duration-300",
                row.state === "done" && "border-accent bg-accent text-accent-fg",
                row.state === "active" && "border-accent bg-surface text-accent",
                row.state === "waiting" && "border-hairline-strong bg-surface text-muted",
              )}
            >
              {row.state === "active" && stage < 3 ? <Spinner /> : row.icon}
            </span>
            <span className="pt-0.5">
              <span className={cn("block text-sm font-medium", row.state === "waiting" && "text-muted")}>{row.title}</span>
              <span className="block text-[0.8125rem] text-muted">{row.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {nothingFound ? (
        <p role="status" className="rounded-lg border border-soon/30 bg-soon-soft px-3 py-2 text-sm">
          No open notice matches yet. Add another category, or continue: new notices are checked every day.
        </p>
      ) : null}
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Add more categories
        </Button>
        {ready > 0 ? (
          <Button variant="primary" size="lg" onClick={() => void navigate({ to: "/o/$orgId/approvals", params: { orgId } })}>
            Decide your first one <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button onClick={() => void navigate({ to: "/o/$orgId", params: { orgId } })}>Skip to the app</Button>
        )}
      </div>
    </div>
  );
}
