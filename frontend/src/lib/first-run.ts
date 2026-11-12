import { useSyncExternalStore } from "react";

/**
 * Small per-browser memory for guidance: which tips were dismissed and when the person last visited.
 * It lives in localStorage, never on the server; if storage is blocked every tip simply shows.
 */
const PREFIX = "tenderline.tip.";
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [dismissed, setDismissed] for one tip id, shared by every component that reads it. */
export function useDismissed(id: string): [boolean, (dismissed: boolean) => void] {
  const dismissed = useSyncExternalStore(subscribe, () => read(PREFIX + id) === "1", () => false);
  return [dismissed, (value) => write(PREFIX + id, value ? "1" : null)];
}

/** Brings back every tip and page introduction (Settings > Preferences). */
export function resetTips(): void {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    /* storage blocked */
  }
  listeners.forEach((listener) => listener());
}

const VISIT = "tenderline.visit.";
const SESSION_GAP_MS = 30 * 60_000;

/**
 * When this person was last here before the current sitting, per organisation. A "sitting" ends after
 * 30 minutes away, so reloading the page does not wipe out what is new since last time.
 */
export function previousVisit(orgId: string, now = Date.now()): number | null {
  const raw = read(VISIT + orgId);
  let state: { previous: number | null; current: number } | null;
  try {
    state = raw ? (JSON.parse(raw) as { previous: number | null; current: number }) : null;
  } catch {
    state = null;
  }
  if (!state) {
    write(VISIT + orgId, JSON.stringify({ previous: null, current: now }));
    return null;
  }
  if (now - state.current > SESSION_GAP_MS) {
    write(VISIT + orgId, JSON.stringify({ previous: state.current, current: now }));
    return state.current;
  }
  // Same sitting: keep the timestamp fresh without notifying subscribers on every call.
  try {
    localStorage.setItem(VISIT + orgId, JSON.stringify({ previous: state.previous, current: now }));
  } catch {
    /* storage blocked */
  }
  return state.previous;
}
