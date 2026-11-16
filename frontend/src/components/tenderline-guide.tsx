import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowRight, Keyboard, MoveHorizontal, Search, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useWrenMood, useWrenReactions } from "@/components/guide/use-wren";
import { Wren } from "@/components/guide/wren";
import { wants3D } from "@/components/guide/wren3d/flight";
import { Wren3D } from "@/components/guide/wren3d/wren-3d";
import { isTyping } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useDismissed } from "@/lib/first-run";
import { findTasks, GUIDANCE, GUIDE_EVENT, sectionFor, type Guidance, type GuideTask } from "@/lib/guidance";

const GREETED_KEY = "tenderline.wren.greeted";

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  const hintId = useId();
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>
        {label}
        <span id={hintId} className="block text-xs text-muted">
          {hint}
        </span>
      </span>
      <input
        type="checkbox"
        className="size-4 accent-[var(--accent)]"
        aria-label={label}
        aria-describedby={hintId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Settings > Your preferences. */
export function GuidePreferences() {
  const [hidden, hide] = useDismissed("guide.hidden");
  const [still, setStill] = useDismissed("guide.still");
  const [lively, setLively] = useDismissed("guide.lively");
  const [flat, setFlat] = useDismissed("guide.flat");
  return (
    <>
      <Toggle
        label="Show Tenderline Guide"
        hint="Wren the owl in the corner, with help for the screen you are on."
        checked={!hidden}
        onChange={(show) => hide(!show)}
      />
      <Toggle label="3D Wren" hint="A 3D owl that flies to what it is showing you. Off: the flat owl stays in its corner." checked={!flat} onChange={(on) => setFlat(!on)} />
      <Toggle label="Reduce guide animation" hint="No flying or blinking at all, and the flat owl instead of the 3D one." checked={still} onChange={setStill} />
      <Toggle
        label="Lively Wren"
        hint="Wren greets you on Today, reacts to your decisions, looks around and dozes off. Off: it keeps still until you ask for help."
        checked={lively}
        onChange={setLively}
      />
    </>
  );
}

/** Text that types itself out while Wren talks. Screen readers get the whole text at once. */
function Typed({ text, calm, onTalking }: { text: string; calm: boolean; onTalking: (talking: boolean) => void }) {
  const [shown, setShown] = useState(calm ? text.length : 0);
  const [typing, setTyping] = useState(text);
  if (typing !== text) {
    setTyping(text);
    setShown(calm ? text.length : 0);
  }
  useEffect(() => {
    if (calm) return;
    let count = 0;
    let timer = 0;
    const start = window.setTimeout(() => {
      onTalking(true);
      timer = window.setInterval(() => {
        count = Math.min(text.length, count + 2);
        setShown(count);
        if (count >= text.length) {
          window.clearInterval(timer);
          onTalking(false);
        }
      }, 22);
    }, 900);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
      onTalking(false);
    };
  }, [text, calm, onTalking]);
  return (
    <p className="text-sm leading-relaxed">
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {text.slice(0, shown)}
        <span className="invisible">{text.slice(shown)}</span>
      </span>
    </p>
  );
}

function Tips({ guidance }: { guidance: Guidance }) {
  const [index, setIndex] = useState(0);
  const [forTips, setForTips] = useState(guidance.tips);
  if (forTips !== guidance.tips) {
    setForTips(guidance.tips);
    setIndex(0);
  }
  if (guidance.tips.length === 0) return null;
  const tip = guidance.tips[index % guidance.tips.length]!;
  return (
    <section className="mt-4 rounded-xl border border-hairline bg-surface-2 p-3" aria-label="Tips">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-accent">
          Tip {(index % guidance.tips.length) + 1} of {guidance.tips.length}
        </span>
        {guidance.tips.length > 1 ? (
          <Button size="sm" variant="ghost" className="-my-1 -mr-2 h-8" onClick={() => setIndex((i) => i + 1)}>
            Next tip
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-[0.8125rem] leading-snug text-muted" aria-live="polite">
        {tip}
      </p>
    </section>
  );
}

/** Finds a task by what someone types. While the box is empty, `children` (the next steps) show instead. */
function TaskFinder({ orgId, onGo, children }: { orgId: string; onGo: (task: GuideTask) => void; children?: ReactNode }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const inputId = useId();
  const results = findTasks(query);
  return (
    <div className="mt-4">
      <label htmlFor={inputId} className="text-sm font-medium">
        What do you want to do?
      </label>
      <div className="relative mt-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = results[0];
            if (e.key === "Enter" && first) {
              e.preventDefault();
              void navigate({ to: first.to, params: { orgId } });
              onGo(first);
            }
          }}
          placeholder="For example: add a reminder"
          autoComplete="off"
          className="h-10 w-full rounded-lg border border-hairline bg-surface-2 pr-3 pl-9 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
        />
      </div>
      {query.trim() ? (
        results.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1" aria-label="Matching tasks">
            {results.map((task) => (
              <li key={task.label}>
                <Link
                  to={task.to}
                  params={{ orgId }}
                  onClick={() => onGo(task)}
                  className="group flex items-start justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2"
                >
                  <span>
                    <span className="block text-sm group-hover:text-accent">{task.label}</span>
                    <span className="block text-xs text-muted">{task.where}</span>
                  </span>
                  <ArrowRight className="mt-0.5 size-4 shrink-0 text-faint group-hover:text-accent" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 px-2 text-xs text-muted" role="status">
            Nothing found. Try words like reminder, watchlist or calendar.
          </p>
        )
      ) : (
        children
      )}
    </div>
  );
}

/** A short hello above the launcher, once per visit, with a real fact about the day. */
function Greeting({ text, left, onOpen, onClose }: { text: string; left: boolean; onOpen: () => void; onClose: () => void }) {
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn("guide-greeting glass glass-strong", left ? "left-0" : "right-0")}
    >
      <button type="button" className="text-left text-sm leading-snug" onClick={onOpen}>
        {text}
      </button>
      <button type="button" aria-label="Dismiss greeting" className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-text" onClick={onClose}>
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

function alreadyGreeted(): boolean {
  try {
    return sessionStorage.getItem(GREETED_KEY) === "1";
  } catch {
    return true;
  }
}

function markGreeted(): void {
  try {
    sessionStorage.setItem(GREETED_KEY, "1");
  } catch {
    /* storage blocked: the greeting simply shows once per page load */
  }
}

function subscribeResize(notify: () => void): () => void {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
}

/** How long Wren stays on a control it is pointing out. */
const SHOW_MS = 7000;

/**
 * Wren, the Tenderline Guide. Help on request: the owl in a bottom corner opens a short explanation of
 * the current screen, tips, a task finder and next steps. It never acts on its own; links only navigate.
 * Wren keeps still (a slow blink aside) until someone asks: then it flies to the panel or to the control
 * it is pointing out. With "Lively Wren" on it also greets, reacts to decisions and dozes when idle.
 */
export function TenderlineGuide({
  orgId,
  toDecide,
  greeting,
  onShortcuts,
}: {
  orgId?: string;
  toDecide?: number;
  /** What Wren says on Today, from data already loaded. Leave out while loading or after an error. */
  greeting?: string;
  onShortcuts?: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [hidden, hide] = useDismissed("guide.hidden");
  const [left, setLeft] = useDismissed("guide.left");
  const [still] = useDismissed("guide.still");
  // By default Wren keeps still and only moves when asked. "Lively Wren" in Settings changes that.
  const [lively] = useDismissed("guide.lively");
  const reduced = useReducedMotion();
  const calm = Boolean(reduced || still);
  const dragged = useRef(false);
  const [greetingShown, setGreetingShown] = useState(false);

  // 3D Wren: on wider screens, unless motion is reduced, it is switched off, or WebGL is missing.
  const [flat] = useDismissed("guide.flat");
  const width = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1024);
  const [failed3D, setFailed3D] = useState(false);
  const [ready3D, setReady3D] = useState(false);
  const want3D = wants3D({ calm, flat, width, failed: failed3D });
  const live3D = want3D && ready3D;
  const [launcher, setLauncher] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  // "Show me": the control Wren has flown to, and the one it is still looking for after navigating.
  const [pointing, setPointing] = useState<string | null>(null);
  const [seeking, setSeeking] = useState<string | null>(null);

  const section = sectionFor(pathname);
  const guidance = GUIDANCE[section];
  const { mood, play } = useWrenMood({ calm, awake: open || greetingShown || !lively });
  useWrenReactions(play, lively);

  const openPanel = (next: boolean) => {
    setOpen(next);
    if (next) {
      setGreetingShown(false);
      setPointing(null);
      play("hello");
    }
  };

  const moveSide = () => {
    setLeft(!left);
    play("fly");
  };

  useEffect(() => {
    const show = () => {
      hide(false);
      setOpen(true);
      play("hello");
    };
    window.addEventListener(GUIDE_EVENT, show);
    return () => window.removeEventListener(GUIDE_EVENT, show);
  }, [hide, play]);

  // "w" opens or closes Wren from anywhere, unless someone is typing.
  useEffect(() => {
    if (hidden) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "w" || isTyping(event)) return;
      event.preventDefault();
      setOpen((was) => {
        if (!was) play("hello");
        return !was;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, play]);

  // The greeting: once per visit, on Today, only with real data, and only for a lively Wren.
  useEffect(() => {
    if (hidden || !lively || !greeting || section !== "today" || alreadyGreeted()) return;
    const show = window.setTimeout(() => {
      markGreeted();
      setGreetingShown(true);
      play("hello");
    }, 1200);
    return () => window.clearTimeout(show);
  }, [hidden, lively, greeting, section, play]);

  useEffect(() => {
    if (!greetingShown) return;
    const hideLater = window.setTimeout(() => setGreetingShown(false), 7000);
    return () => window.clearTimeout(hideLater);
  }, [greetingShown]);

  // A new screen gets fresh help: close the panel when the route changes.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  const onTalking = useCallback((talking: boolean) => play(talking ? "talk" : "idle"), [play]);

  // After a task is chosen the screen changes; wait for its control to appear, then fly to it.
  useEffect(() => {
    if (!seeking) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const selector = `[data-wren-target="${seeking}"]`;
      const found = document.querySelector<HTMLElement>(selector);
      tries += 1;
      if (found || tries > 30) {
        window.clearInterval(timer);
        setSeeking(null);
        if (found) {
          found.scrollIntoView({ block: "center", behavior: "smooth" });
          setPointing(selector);
        }
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [seeking]);

  useEffect(() => {
    if (!pointing) return;
    const greet = window.setTimeout(() => play("hello"), 900);
    const leave = window.setTimeout(() => setPointing(null), SHOW_MS);
    return () => {
      window.clearTimeout(greet);
      window.clearTimeout(leave);
    };
  }, [pointing, play]);

  const goToTask = (task: GuideTask) => {
    setOpen(false);
    setPointing(null);
    setSeeking(live3D && task.target ? task.target : null);
  };
  const stopPointing = useCallback(() => setPointing(null), []);

  if (hidden) return null;
  return (
    <motion.div
      layout={!calm}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className={cn("guide-dock", left ? "guide-left" : "guide-right", live3D && "guide-dock-3d")}
    >
      <AnimatePresence>
        {greetingShown && greeting && !open ? (
          <Greeting text={greeting} left={left} onOpen={() => openPanel(true)} onClose={() => setGreetingShown(false)} />
        ) : null}
      </AnimatePresence>
      <Popover.Root open={open} onOpenChange={openPanel}>
        <Popover.Trigger asChild>
          <motion.button
            ref={setLauncher}
            type="button"
            className={cn("guide-launcher glass glass-strong", live3D && "guide-launcher-3d")}
            aria-label="Wren: open Tenderline Guide"
            aria-keyshortcuts="w"
            drag="x"
            dragSnapToOrigin
            dragMomentum={false}
            dragElastic={0.2}
            dragConstraints={{ left: 0, right: 0 }}
            onPointerDown={() => {
              dragged.current = false;
            }}
            onDragStart={() => {
              dragged.current = true;
            }}
            onDragEnd={(_, info) => {
              if (Math.abs(info.offset.x) > 40 && info.offset.x < 0 !== left) moveSide();
            }}
            onClickCapture={(e) => {
              if (dragged.current) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            {live3D ? <span className="guide-launcher-perch" aria-hidden /> : <Wren mood={mood} calm={calm} size={38} quiet={!lively} track={lively || open} />}
            <span className="max-sm:sr-only">Wren</span>
          </motion.button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align={left ? "start" : "end"}
            sideOffset={12}
            ref={setPanel}
            collisionPadding={{ top: want3D ? 128 : 16, right: 16, bottom: 16, left: 16 }}
            className="guide-panel glass glass-strong"
            aria-label="Tenderline Guide"
            data-perch-x="54"
          >
            <motion.div
              initial={calm ? false : { opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-start gap-3">
                {live3D ? null : <Wren mood={mood} calm={calm} size={56} quiet={!lively} />}
                <div className="min-w-0 flex-1 pt-1">
                  <p className="text-xs font-medium text-accent">Hi, I&apos;m Wren</p>
                  <h2 className="text-lg leading-snug font-semibold">{guidance.title}</h2>
                </div>
                <Popover.Close asChild>
                  <Button size="icon" variant="ghost" aria-label="Close guide" className="-mt-1 -mr-2">
                    <X className="size-4" />
                  </Button>
                </Popover.Close>
              </div>

              <div className="guide-bubble mt-3">
                <Typed key={section} text={guidance.body} calm={calm} onTalking={onTalking} />
              </div>

              <Tips guidance={guidance} />

              {orgId ? (
                <TaskFinder orgId={orgId} onGo={goToTask}>
                  {guidance.links.length > 0 ? (
                    <nav className="mt-4 flex flex-col divide-y divide-hairline border-y border-hairline" aria-label="Next steps">
                      {guidance.links.slice(0, 3).map((link) => (
                        <Link
                          key={link.to}
                          to={link.to}
                          params={{ orgId }}
                          onClick={() => setOpen(false)}
                          className="group flex min-h-11 items-center justify-between gap-3 py-2 text-sm hover:text-accent"
                        >
                          <span>
                            {link.label}
                            {link.to === "/o/$orgId/approvals" && toDecide ? (
                              <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent tabular-nums">{toDecide} waiting</span>
                            ) : null}
                          </span>
                          <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                        </Link>
                      ))}
                    </nav>
                  ) : null}
                </TaskFinder>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                {onShortcuts ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      onShortcuts();
                    }}
                  >
                    <Keyboard className="size-4" />
                    Shortcuts
                  </Button>
                ) : null}
                <Button size="sm" onClick={moveSide}>
                  <MoveHorizontal className="size-4" />
                  Move to other side
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    hide(true);
                  }}
                >
                  Hide guide
                </Button>
              </div>
              <p className="mt-3 text-xs text-faint">Press w to open me from anywhere. Bring me back in Settings if you hide me.</p>
            </motion.div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {want3D
        ? createPortal(
            <Wren3D
              mood={mood}
              lively={lively}
              attentive={lively || open || pointing !== null || seeking !== null}
              home={launcher}
              perch={pointing ?? (open ? panel : null)}
              onReady={() => setReady3D(true)}
              onFail={() => setFailed3D(true)}
              onPerchLost={stopPointing}
            />,
            document.body,
          )
        : null}
    </motion.div>
  );
}
