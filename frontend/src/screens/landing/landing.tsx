import { Link } from "@tanstack/react-router";
import { ArrowRight, BellRing, FileText, Moon, ShieldCheck, Sparkles, Sun, Target, UserCheck } from "lucide-react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { lazy, Suspense, useRef, type ReactNode } from "react";

import { useMetadata } from "@/api/hooks";
import { useSession } from "@/auth/use-session";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { setTheme, useTheme } from "@/lib/theme";

import { DecisionDemo } from "./demo";

const Aurora = lazy(() => import("./aurora").then((m) => ({ default: m.Aurora })));
const EASE = [0.22, 1, 0.36, 1] as const;

export function Landing() {
  const theme = useTheme();
  const session = useSession();
  const metadata = useMetadata();

  return (
    <div className="bg-bg text-text">
      <header className="absolute inset-x-0 top-0 z-20">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link to={session ? "/app" : "/sign-in"}>{session ? "Open Tenderline" : "Sign in"}</Link>
            </Button>
          </nav>
        </div>
      </header>

      <Hero theme={theme} signedIn={Boolean(session)} devServer={metadata.data?.env === "dev"} />
      <HowItWorks />
      <DecisionDemo />
      <Screenshot theme={theme} />
      <Sources metadata={metadata.data} />

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-xs text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo compact />
          <p className="max-w-2xl">{metadata.data?.disclaimer ?? "Tenderline provides information and AI suggestions only. A person decides every action."}</p>
          {metadata.data ? <p className="font-mono">v{metadata.data.version}</p> : null}
        </div>
      </footer>
    </div>
  );
}

function Hero({ theme, signedIn, devServer }: { theme: "dark" | "light"; signedIn: boolean; devServer: boolean }) {
  return (
    <section className="relative isolate flex min-h-[min(100dvh,56rem)] items-center overflow-hidden">
      <div className="app-backdrop absolute inset-0 -z-10" aria-hidden>
        <Suspense fallback={null}>
          <Aurora theme={theme} />
        </Suspense>
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-bg" />
      </div>

      <div className="mx-auto grid w-full max-w-6xl items-end gap-10 px-4 pt-28 pb-20 sm:px-6 lg:grid-cols-[1.35fr_1fr] lg:pb-28">
        <div>
          <motion.p
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-hairline bg-surface/40 px-3 py-1 text-xs text-muted backdrop-blur"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.56, ease: EASE }}
          >
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            For Irish companies bidding on public contracts
          </motion.p>
          <h1 className="text-[clamp(2.4rem,6.2vw,4.6rem)] leading-[0.98] font-semibold tracking-[-0.035em]">
            <Line delay={0.05}>The tenders worth your time,</Line>
            <Line delay={0.15} className="text-accent">
              and nothing done without you.
            </Line>
          </h1>
          <motion.p
            className="mt-6 max-w-xl text-[1.0625rem] leading-relaxed text-muted"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.56, delay: 0.3, ease: EASE }}
          >
            Tenderline reads new notices from TED and eTenders, checks each one against what your company actually does,
            and drafts the next step. Someone on your team approves it, or it doesn't happen.
          </motion.p>
        </div>

        <motion.aside
          className="glass rounded-2xl p-6"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.56, delay: 0.35, ease: EASE }}
          aria-label="Get started"
        >
          <ul className="flex flex-col gap-3 text-sm">
            <Point icon={<FileText className="size-4" />}>New EU and Irish notices collected every day</Point>
            <Point icon={<Sparkles className="size-4" />}>A fit score, reasons and risks for each match</Point>
            <Point icon={<UserCheck className="size-4" />}>You approve, edit or reject each suggestion</Point>
            <Point icon={<BellRing className="size-4" />}>Reminders before every submission deadline</Point>
          </ul>
          <Button asChild variant="primary" size="lg" className="mt-6 w-full justify-center">
            <Link to={signedIn ? "/app" : "/sign-in"}>
              {signedIn ? "Open your workspace" : devServer ? "Try it now, no account needed" : "Sign in with GitHub"} <ArrowRight className="size-4" />
            </Link>
          </Button>
        </motion.aside>
      </div>
    </section>
  );
}

function Line({ children, delay, className }: { children: ReactNode; delay: number; className?: string }) {
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <motion.span
        className={cn("block", className)}
        initial={{ y: "105%" }}
        animate={{ y: 0 }}
        transition={{ duration: 0.72, delay, ease: EASE }}
      >
        {children}
      </motion.span>
    </span>
  );
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ how it works */
const STAGES = [
  { title: "A notice is published", body: "On TED or eTenders. Tenderline collects it, and every later correction to it.", icon: FileText },
  { title: "It matches a watchlist", body: "Your watchlists: categories, keywords, buyers, countries, value range.", icon: Target },
  { title: "The assistant suggests", body: "A fit score from 0 to 100, its reasons and risks, and up to five concrete actions.", icon: Sparkles },
  { title: "A person decides", body: "Approve, edit then approve, or reject with a reason. Every step is in the audit log.", icon: UserCheck },
  { title: "Deadlines are watched", body: "The tender joins your pipeline, reminders come due on time, and changes to the notice are flagged.", icon: BellRing },
];

function HowItWorks() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 60%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  return (
    <section ref={ref} className="relative mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:py-32" aria-labelledby="how-title">
      <div className="max-w-xl">
        <p className="text-sm font-medium text-accent">How it works</p>
        <h2 id="how-title" className="mt-2 text-[clamp(1.8rem,3.6vw,2.6rem)] leading-tight font-semibold tracking-[-0.02em]">
          From a buyer's notice to your decision, with a record of each step.
        </h2>
      </div>

      <div className="relative mt-14">
        {/* The line that draws as you scroll: horizontal on wide screens, vertical on phones. */}
        <svg className="absolute top-6 right-[10%] left-[10%] hidden h-2 lg:block" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden>
          <line x1="0" y1="1" x2="100" y2="1" stroke="var(--hairline-strong)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <motion.line x1="0" y1="1" x2="100" y2="1" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ pathLength: reduce ? 1 : progress }} />
        </svg>
        <svg className="absolute top-6 bottom-6 left-6 w-2 lg:hidden" viewBox="0 0 2 100" preserveAspectRatio="none" aria-hidden>
          <line x1="1" y1="0" x2="1" y2="100" stroke="var(--hairline-strong)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <motion.line x1="1" y1="0" x2="1" y2="100" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ pathLength: reduce ? 1 : progress }} />
        </svg>
        <ol className="relative grid gap-10 lg:grid-cols-5 lg:gap-6">
          {STAGES.map((stage, index) => (
            <Stage key={stage.title} index={index} progress={progress} reduce={Boolean(reduce)} {...stage} />
          ))}
        </ol>
      </div>
    </section>
  );
}

function Stage({
  index,
  title,
  body,
  icon: Icon,
  progress,
  reduce,
}: {
  index: number;
  title: string;
  body: string;
  icon: typeof FileText;
  progress: MotionValue<number>;
  reduce: boolean;
}) {
  const at = index / (STAGES.length - 1);
  // The icon lights up as the line reaches it; the text stays at full contrast throughout.
  const lit = useTransform(progress, [Math.max(0, at - 0.08), at], [0, 1]);
  const y = useTransform(lit, [0, 1], [6, 0]);
  return (
    <motion.li className="relative flex gap-4 pl-0 lg:flex-col lg:items-center lg:text-center" style={reduce ? undefined : { y }}>
      <span className="relative z-10 grid size-12 shrink-0 place-items-center rounded-full border border-hairline-strong bg-surface">
        <motion.span className="absolute inset-0 rounded-full bg-accent" style={{ opacity: reduce ? 1 : lit }} aria-hidden />
        <Icon className="relative size-5 text-text" aria-hidden />
      </span>
      <div>
        <p className="tabular font-mono text-xs text-muted">0{index + 1}</p>
        <h3 className="mt-1 font-medium">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </motion.li>
  );
}

/* ------------------------------------------------------------------ real screenshot */
function Screenshot({ theme }: { theme: "dark" | "light" }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const rotateX = useTransform(scrollYProgress, [0, 0.5, 1], [10, 0, -4]);
  const y = useTransform(scrollYProgress, [0, 1], [40, -40]);
  return (
    <section className="relative overflow-hidden py-12 lg:py-20" aria-labelledby="screen-title">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mb-10 grid gap-4 lg:grid-cols-[1fr_1fr] lg:items-end">
          <h2 id="screen-title" className="text-[clamp(1.6rem,3.2vw,2.3rem)] leading-tight font-semibold tracking-[-0.02em]">
            The approvals inbox, where most of the work happens.
          </h2>
          <p className="text-muted">
            Notices waiting for a decision, best fit first. Each suggested action shows what it will do, and the assistant's
            text is labelled as a suggestion. Keyboard shortcuts move through the list.
          </p>
        </div>
        <div ref={ref} style={{ perspective: 1600 }}>
          <motion.figure className="glass overflow-hidden rounded-2xl p-1.5" style={reduce ? undefined : { rotateX, y, transformOrigin: "50% 100%" }}>
            <img
              src={`/screens/approvals-${theme}.jpg`}
              alt="The Tenderline approvals screen: a list of notices with fit scores on the left, and on the right one notice's reasons, risks and proposed actions with Approve, Edit and Reject buttons."
              width={1440}
              height={900}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full rounded-xl"
            />
          </motion.figure>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ sources and licences */
interface SourceInfo {
  name?: string;
  publisher?: string;
  source?: string;
  terms?: string;
  licence?: string;
  licence_url?: string;
  attribution?: string;
}

function Sources({ metadata }: { metadata: { data_sources: Record<string, unknown>; disclaimer: string } | undefined }) {
  const entries = Object.entries(metadata?.data_sources ?? {}).filter(([, v]) => v && typeof v === "object") as [string, SourceInfo][];
  const policy = metadata?.data_sources?.free_text_policy;
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="sources-title">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <ShieldCheck className="size-6 text-accent" aria-hidden />
          <h2 id="sources-title" className="mt-3 text-[clamp(1.5rem,2.8vw,2rem)] leading-tight font-semibold tracking-[-0.02em]">
            Open data, credited properly.
          </h2>
          {typeof policy === "string" ? <p className="mt-3 text-sm leading-relaxed text-muted">{policy}</p> : null}
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {entries.map(([key, source], index) => (
            <motion.li
              key={key}
              className="panel flex flex-col gap-3 p-5"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.56, delay: index * 0.08, ease: EASE }}
            >
              <h3 className="font-medium">{source.name ?? key}</h3>
              {source.publisher ? <p className="text-sm text-muted">{source.publisher}</p> : null}
              {source.attribution ? <p className="text-xs leading-relaxed text-faint">{source.attribution}</p> : null}
              <p className="mt-auto flex flex-wrap gap-3 text-sm">
                {source.source ? <ExternalLink href={source.source}>Source</ExternalLink> : null}
                {source.licence_url ? <ExternalLink href={source.licence_url}>{source.licence ?? "Licence"}</ExternalLink> : null}
                {source.terms ? <ExternalLink href={source.terms}>Terms of reuse</ExternalLink> : null}
              </p>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent">
      {children}
    </a>
  );
}
