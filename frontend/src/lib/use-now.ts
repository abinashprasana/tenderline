import { useSyncExternalStore } from "react";

/**
 * One clock for the whole app. Every countdown, "3 minutes ago" and greeting reads the time from here, so
 * they all move together, render stays pure (no Date.now() in components), and there is a single timer
 * however many chips are on screen. It ticks every 20 seconds and again when the tab becomes visible.
 */
const TICK_MS = 20_000;
let now = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();

function tick() {
  now = Date.now();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    }
  };
}

function snapshot(): number {
  // If nothing was subscribed for a while the stored time is old; refresh it before the first read.
  if (Date.now() - now > 2 * TICK_MS) now = Date.now();
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
