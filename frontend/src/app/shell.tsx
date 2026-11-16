import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  CalendarClock,
  Check,
  ChevronsUpDown,
  FileSearch,
  Inbox,
  KanbanSquare,
  LogOut,
  Menu,
  Moon,
  Search,
  ScrollText,
  Settings,
  Sparkles,
  Keyboard,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useMyOrgs, useRuns, useSummary } from "@/api/hooks";
import { setSession } from "@/auth/session";
import { useSession } from "@/auth/use-session";
import { Ago } from "@/components/deadline-chip";
import { TenderlineGuide } from "@/components/tenderline-guide";
import { Logo } from "@/components/logo";
import { Shortcuts } from "@/components/shortcuts";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd, Tooltip } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";
import { greeting } from "@/lib/format";
import { plural, RUN_STATUS, SCREEN } from "@/lib/labels";
import { ROLE_LABEL, type Role } from "@/lib/permissions";
import { setReducedTransparency, setTheme, useReducedTransparency, useTheme } from "@/lib/theme";

import { CommandPalette } from "./command-palette";
import { useOrg } from "./org";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Which live count to show beside the label. */
  count?: "decide" | "deadlines";
}

// In the order of the work: see what needs you, decide, follow the tenders you chose, then the reference screens.
export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Your work",
    items: [
      { to: "/o/$orgId", label: SCREEN.today, icon: Sun, exact: true },
      { to: "/o/$orgId/approvals", label: SCREEN.decide, icon: Inbox, count: "decide" },
      { to: "/o/$orgId/opportunities", label: SCREEN.pipeline, icon: KanbanSquare },
      { to: "/o/$orgId/deadlines", label: SCREEN.deadlines, icon: CalendarClock, count: "deadlines" },
    ],
  },
  {
    group: "Find tenders",
    items: [
      { to: "/o/$orgId/matches", label: SCREEN.matched, icon: Sparkles },
      { to: "/o/$orgId/notices", label: SCREEN.notices, icon: FileSearch },
      { to: "/o/$orgId/searches", label: SCREEN.watchlists, icon: Bell },
    ],
  },
  {
    group: "Records",
    items: [
      { to: "/o/$orgId/audit", label: SCREEN.audit, icon: ScrollText },
      { to: "/o/$orgId/ingestion", label: SCREEN.sources, icon: Activity },
      { to: "/o/$orgId/settings", label: SCREEN.settings, icon: Settings },
    ],
  },
];

/** The four screens people use every day, for the bar at the bottom of narrow windows. */
const BOTTOM = NAV[0]!.items;

/** What Wren says on Today: one real fact, or nothing while the summary is loading or failed. */
function wrenGreeting(summary: { notices_awaiting_decision: number; deadlines_next_7_days: number } | undefined): string | undefined {
  if (!summary) return undefined;
  const hello = greeting();
  if (summary.notices_awaiting_decision > 0) {
    return `${hello}! ${plural(summary.notices_awaiting_decision, "notice is", "notices are")} waiting for your decision.`;
  }
  if (summary.deadlines_next_7_days > 0) {
    return `${hello}! ${plural(summary.deadlines_next_7_days, "deadline")} in the next 7 days.`;
  }
  return `${hello}! Nothing is waiting for you. I'll keep watch.`;
}

export function Shell() {
  const org = useOrg();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigate = useNavigate();
  const summary = useSummary(org.id);
  const toDecide = summary.data?.notices_awaiting_decision ?? 0;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The browser tab says how many notices are waiting, so a pinned tab is worth a glance.
  useEffect(() => {
    document.title = toDecide > 0 ? `(${toDecide}) Tenderline` : "Tenderline";
    return () => {
      document.title = "Tenderline";
    };
  }, [toDecide]);

  const go = useCallback(
    (key: string) => {
      const to = key === "t" ? "/o/$orgId" : key === "d" ? "/o/$orgId/approvals" : "/o/$orgId/opportunities";
      void navigate({ to, params: { orgId: org.id } });
    },
    [navigate, org.id],
  );

  return (
    <div className="app-backdrop grain min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] focus:rounded-full focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>
      <aside className="glass fixed inset-y-3 left-3 z-30 hidden w-60 flex-col rounded-2xl lg:flex">
        <Sidebar orgId={org.id} place="side" />
      </aside>

      <AnimatePresence>
        {drawerOpen ? (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-[oklch(0.1_0.02_230/0.5)] lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="glass glass-strong fixed inset-y-2 left-2 z-50 flex w-[min(17rem,calc(100vw-1rem))] flex-col rounded-2xl lg:hidden"
              initial={{ x: "-105%" }}
              animate={{ x: 0 }}
              exit={{ x: "-105%" }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              aria-label="Navigation"
            >
              <Sidebar orgId={org.id} place="drawer" />
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <div className="lg:pl-[16.5rem]">
        <TopBar onMenu={() => setDrawerOpen(true)} onPalette={() => setPaletteOpen(true)} onShortcuts={() => setShortcutsOpen(true)} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[90rem] px-4 pt-4 pb-28 focus:outline-none sm:px-6 lg:px-8 lg:pb-16">
          {/* A short fade between pages tells you the content changed without slowing you down. */}
          <motion.div key={pathname} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
            <Outlet />
          </motion.div>
        </main>
      </div>
      <TenderlineGuide orgId={org.id} toDecide={summary.data?.notices_awaiting_decision} greeting={wrenGreeting(summary.data)} onShortcuts={() => setShortcutsOpen(true)} />
      <BottomBar orgId={org.id} toDecide={toDecide} onMore={() => setDrawerOpen(true)} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Shortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} onGo={go} />
    </div>
  );
}

function Sidebar({ orgId, place }: { orgId: string; place: "side" | "drawer" }) {
  const summary = useSummary(orgId);
  const matchRoute = useMatchRoute();
  const counts = {
    decide: summary.data?.notices_awaiting_decision ?? 0,
    deadlines: summary.data?.deadlines_next_7_days ?? 0,
  };
  return (
    <>
      <div className="flex h-14 items-center px-4">
        <Link to="/o/$orgId" params={{ orgId }} aria-label="Tenderline overview">
          <Logo />
        </Link>
      </div>
      <OrgSwitcher />
      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
        {NAV.map((section) => (
          <div key={section.group} className="mt-4">
            <p className="px-3 pb-1 text-[0.6875rem] font-medium tracking-[0.06em] text-faint uppercase">{section.group}</p>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    params={{ orgId }}
                    activeOptions={{ exact: item.exact ?? false }}
                    className={cn(
                      "group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm text-muted",
                      "transition-colors duration-150 hover:bg-surface-2/70 hover:text-text",
                      "data-[status=active]:text-text",
                    )}
                  >
                    {/* The highlight slides from the old item to the new one, so you see where you went. */}
                    {matchRoute({ to: item.to, params: { orgId }, fuzzy: !item.exact }) ? (
                      <motion.span
                        layoutId={`nav-active-${place}`}
                        className="absolute inset-0 rounded-lg border-l-2 border-accent bg-accent-soft"
                        transition={{ type: "spring", stiffness: 520, damping: 42 }}
                        aria-hidden
                      />
                    ) : null}
                    <item.icon className="relative size-4 shrink-0 group-data-[status=active]:text-accent" aria-hidden />
                    <span className="relative flex-1">{item.label}</span>
                    {item.count && counts[item.count] > 0 ? (
                      <span
                        className={cn(
                          "tabular relative rounded-full px-1.5 text-[0.6875rem] leading-5 font-semibold",
                          item.count === "decide" ? "bg-accent text-accent-fg" : "bg-soon-soft text-soon",
                        )}
                      >
                        {counts[item.count]}
                        <span className="sr-only">{item.count === "decide" ? " notices waiting for you" : " due this week"}</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <p className="px-5 pb-4 text-[0.6875rem] leading-snug text-faint">
        Information and AI suggestions only. A person approves every action.
      </p>
    </>
  );
}

function OrgSwitcher() {
  const current = useOrg();
  const orgs = useMyOrgs();
  const navigate = useNavigate();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="mx-2 flex items-center gap-3 rounded-xl border border-hairline bg-surface/50 px-3 py-2 text-left transition-colors hover:border-hairline-strong"
        >
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-sm font-semibold">
            {current.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{current.name}</span>
            <span className="block text-xs text-faint">{ROLE_LABEL[current.role as Role] ?? current.role}</span>
            <span className="sr-only">, switch organisation</span>
          </span>
          <ChevronsUpDown className="size-4 text-faint" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <MenuContent align="start">
        <DropdownMenu.Label className="px-2 py-1.5 text-xs text-faint">Organisations</DropdownMenu.Label>
        {(orgs.data ?? []).map((org) => (
          <MenuItem key={org.id} onSelect={() => void navigate({ to: "/o/$orgId", params: { orgId: org.id } })}>
            <span className="flex-1 truncate">{org.name}</span>
            {org.id === current.id ? <Check className="size-4 text-accent" aria-label="Current" /> : null}
          </MenuItem>
        ))}
        <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
        <MenuItem onSelect={() => void navigate({ to: "/welcome" })}>New organisation…</MenuItem>
      </MenuContent>
    </DropdownMenu.Root>
  );
}

function TopBar({ onMenu, onPalette, onShortcuts }: { onMenu: () => void; onPalette: () => void; onShortcuts: () => void }) {
  return (
    <div className="sticky top-0 z-20 px-3 pt-3 lg:pr-3 lg:pl-0">
      <div className="glass flex h-12 items-center gap-2 rounded-2xl px-2 sm:px-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
        <button
          onClick={onPalette}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-bg-deep/40 px-3 text-sm text-faint transition-colors hover:border-hairline-strong sm:max-w-sm"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="truncate">Search notices, jump to…</span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <IngestionPill />
          <ThemeToggle />
          <UserMenu onShortcuts={onShortcuts} />
        </div>
      </div>
    </div>
  );
}

/** When notices were last collected. Turns amber if the daily check is more than 36 hours old. */
function IngestionPill() {
  const org = useOrg();
  const runs = useRuns();
  const now = useNow();
  const last = runs.data?.[0];
  if (!last) return null;
  const when = last.finished_at ?? last.started_at;
  const stale = now - new Date(when).getTime() > 36 * 3600_000;
  const tone = last.status === "error" ? "lost" : stale ? "soon" : (STATUS_TONE[last.status] ?? "neutral");
  return (
    <Tooltip
      label={`${RUN_STATUS[last.status] ?? last.status}: the last check of TED and eTenders found ${last.notices_new} new ${last.notices_new === 1 ? "notice" : "notices"}.${stale ? " That is longer ago than expected." : ""}`}
    >
      <Link to="/o/$orgId/ingestion" params={{ orgId: org.id }} className="hidden sm:block">
        <Badge tone={tone} icon={<span className={cn("size-1.5 rounded-full bg-current", last.status === "running" && "animate-pulse motion-reduce:animate-none")} />}>
          Notices checked <Ago at={when} />
        </Badge>
      </Link>
    </Tooltip>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`}>
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const session = useSession();
  const reduced = useReducedTransparency();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!session) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="grid size-8 place-items-center rounded-full bg-surface-3 text-sm font-semibold transition-shadow hover:ring-2 hover:ring-hairline-strong"
        >
          <span aria-hidden>{session.login.slice(0, 1).toUpperCase()}</span>
          <span className="sr-only">Account: {session.login}</span>
        </button>
      </DropdownMenu.Trigger>
      <MenuContent align="end">
        <DropdownMenu.Label className="px-2 py-1.5 text-sm">
          Signed in as <span className="font-medium">{session.login}</span>
        </DropdownMenu.Label>
        <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
        <DropdownMenu.CheckboxItem
          checked={reduced}
          onCheckedChange={(on) => setReducedTransparency(on === true)}
          className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-3"
        >
          <span className="grid size-4 place-items-center">
            <DropdownMenu.ItemIndicator>
              <Check className="size-4 text-accent" />
            </DropdownMenu.ItemIndicator>
          </span>
          Reduce transparency
        </DropdownMenu.CheckboxItem>
        <MenuItem onSelect={onShortcuts}>
          <Keyboard className="size-4" /> Keyboard shortcuts
        </MenuItem>
        <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
        <MenuItem
          onSelect={() => {
            setSession(null);
            queryClient.clear();
            void navigate({ to: "/" });
          }}
        >
          <LogOut className="size-4" /> Sign out
        </MenuItem>
      </MenuContent>
    </DropdownMenu.Root>
  );
}

export function MenuContent({ children, align }: { children: ReactNode; align: "start" | "end" }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        className="glass glass-strong z-[60] min-w-56 rounded-xl p-1 data-[state=open]:animate-in"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-3"
    >
      {children}
    </DropdownMenu.Item>
  );
}

/** On narrow windows the four daily screens sit under the thumb; everything else is behind "More". */
function BottomBar({ orgId, toDecide, onMore }: { orgId: string; toDecide: number; onMore: () => void }) {
  return (
    <nav aria-label="Main, compact" className="glass fixed inset-x-2 bottom-2 z-30 flex h-14 items-stretch rounded-2xl px-1 lg:hidden">
      {BOTTOM.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          params={{ orgId }}
          activeOptions={{ exact: item.exact ?? false }}
          className="group relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.6875rem] text-muted data-[status=active]:text-text"
        >
          <span className="relative">
            <item.icon className="size-5 group-data-[status=active]:text-accent" aria-hidden />
            {item.count === "decide" && toDecide > 0 ? (
              <span className="tabular absolute -top-1.5 -right-3 rounded-full bg-accent px-1 text-[0.625rem] leading-4 font-semibold text-accent-fg">
                {toDecide > 99 ? "99+" : toDecide}
              </span>
            ) : null}
          </span>
          {item.label}
        </Link>
      ))}
      <button onClick={onMore} className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.6875rem] text-muted">
        <Menu className="size-5" aria-hidden />
        More
      </button>
    </nav>
  );
}
