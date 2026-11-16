import { AlertTriangle, Check, FileText, RotateCcw, Sparkles, UserCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { FitRing } from "@/components/fit-ring";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const EASE = [0.22, 1, 0.36, 1] as const;

const STEPS = [
  { key: "notice", label: "A notice arrives", icon: FileText },
  { key: "assessment", label: "The assistant assesses it", icon: Sparkles },
  { key: "decision", label: "You decide", icon: UserCheck },
] as const;

/**
 * A three-step walk through one decision, built from the app's own components. The notice is an invented
 * example and says so; nothing here talks to the server.
 */
export function DecisionDemo() {
  const [step, setStep] = useState(0);
  const [approved, setApproved] = useState(false);
  const go = (index: number) => {
    setStep(index);
    if (index < 2) setApproved(false);
  };

  return (
    <section id="try-a-decision" tabIndex={-1} className="scroll-mt-8 mx-auto max-w-6xl px-4 py-16 sm:px-6" aria-labelledby="demo-title">
      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr] lg:items-center">
        <div>
          <p className="text-sm font-medium text-accent">Try it</p>
          <h2 id="demo-title" className="mt-2 text-[clamp(1.6rem,3.2vw,2.3rem)] leading-tight font-semibold tracking-[-0.02em]">
            Try one decision yourself
          </h2>
          <p className="mt-3 text-muted">Follow a single tender from the notice to your yes or no. It takes about ten seconds.</p>
          <ol className="mt-6 flex flex-col gap-1.5">
            {STEPS.map((item, index) => (
              <li key={item.key}>
                <button
                  onClick={() => go(index)}
                  aria-current={step === index ? "step" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors",
                    step === index ? "border-accent/40 bg-accent-soft text-text" : "border-transparent text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border", index <= step ? "border-accent text-accent" : "border-hairline-strong")}>
                    {index < step ? <Check className="size-4" /> : <item.icon className="size-4" />}
                  </span>
                  <span className="font-medium">
                    {index + 1}. {item.label}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="panel relative flex flex-col overflow-hidden p-5 sm:p-6">
          <Badge className="absolute top-4 right-4">Example, not a real notice</Badge>
          {/* All three steps share one grid cell, so the card is always as tall as the tallest step and never jumps. */}
          <div className="grid flex-1">
            <Step index={0} step={step}>
              <p className="text-xs text-muted">Published on TED. It matched your watchlist "IT services, Ireland"</p>
              <h3 className="mt-2 max-w-md text-lg leading-snug font-semibold">Managed cloud hosting and security monitoring for a county council</h3>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <Fact label="Buyer">A county council</Fact>
                <Fact label="Estimated value">€180,000</Fact>
                <Fact label="Closes in">23 days</Fact>
                <Fact label="Category">IT services</Fact>
              </dl>
              <p className="mt-4 text-sm text-muted">Tenderline collected it this morning and kept it because it matches what you sell.</p>
            </Step>
            <Step index={1} step={step}>
              <div className="flex items-center gap-4">
                <FitRing score={82} size={56} />
                <div>
                  <p className="font-semibold">Strong fit</p>
                  <p className="text-sm text-muted">Scored against your company profile</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <ul className="flex flex-col gap-1.5 text-sm text-muted">
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-won" /> Cloud hosting and security are in your capabilities
                  </li>
                  <li className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-won" /> Value is inside the range you take on
                  </li>
                </ul>
                <ul className="flex flex-col gap-1.5 text-sm text-muted">
                  <li className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-soon" /> Asks for a certification your profile does not list
                  </li>
                </ul>
              </div>
              <p className="mt-4 text-sm text-muted">The assistant only suggests. It cannot track, remind or reject anything by itself.</p>
            </Step>
            <Step index={2} step={step}>
              <p className="text-sm font-medium">Suggested action</p>
              <div className="mt-2 rounded-lg border border-hairline bg-surface-2 p-4">
                <p className="font-medium">Track in the pipeline</p>
                <p className="mt-1 text-sm text-muted">Adds the notice to your pipeline with its submission deadline.</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <AnimatePresence mode="wait" initial={false}>
                    {approved ? (
                      <motion.p
                        key="done"
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="inline-flex items-center gap-2 rounded-full bg-won-soft px-3 py-1.5 text-sm text-won"
                        role="status"
                      >
                        <Check className="size-4" /> Done. Recorded in the audit log under your name.
                      </motion.p>
                    ) : (
                      <motion.div key="buttons" exit={{ opacity: 0 }} className="flex flex-wrap gap-2">
                        <Button variant="primary" size="sm" onClick={() => setApproved(true)}>
                          <Check className="size-3.5" /> Approve
                        </Button>
                        <Button size="sm" disabled>
                          Edit and approve
                        </Button>
                        <Button size="sm" variant="ghost" disabled>
                          Reject
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              {approved ? null : <p className="mt-3 text-sm text-muted">Press Approve to see what happens.</p>}
            </Step>
          </div>
          <footer className="mt-5 flex items-center justify-between gap-3 border-t border-hairline pt-4">
            <span className="text-xs text-muted">
              Step {step + 1} of {STEPS.length}
            </span>
            {step < 2 ? (
              <Button variant="primary" size="sm" onClick={() => go(step + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => go(0)} disabled={!approved}>
                <RotateCcw className="size-3.5" /> Start again
              </Button>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}

/** One step of the walk-through. Inactive steps keep their space but are hidden from sight, the keyboard and screen readers. */
function Step({ index, step, children }: { index: number; step: number; children: ReactNode }) {
  const active = index === step;
  return (
    <motion.div
      className={cn("[grid-area:1/1] flex flex-col", active ? "" : "invisible")}
      aria-hidden={!active}
      inert={!active}
      initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: -6 }}
      transition={{ duration: 0.22, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular font-mono">{children}</dd>
    </div>
  );
}
