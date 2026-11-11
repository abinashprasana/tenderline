import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const root = () => document.documentElement;
const listeners = new Set<() => void>();

function persist(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

export function setTheme(theme: Theme): void {
  const apply = () => {
    root().dataset.theme = theme;
    persist("tenderline.theme", theme);
    listeners.forEach((listener) => listener());
  };
  // Cross-fade the whole page when the browser supports view transitions and motion is welcome.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("startViewTransition" in document)) return apply();
  // A skipped transition still runs `apply`; it only rejects the animation promises, which we ignore.
  const transition = document.startViewTransition(apply);
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

export function setReducedTransparency(on: boolean): void {
  if (on) root().dataset.transparency = "reduced";
  else delete root().dataset.transparency;
  persist("tenderline.transparency", on ? "reduced" : null);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => (root().dataset.theme === "light" ? "light" : "dark"));
}

export function useReducedTransparency(): boolean {
  return useSyncExternalStore(subscribe, () => root().dataset.transparency === "reduced");
}
