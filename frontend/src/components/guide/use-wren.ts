import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

/** What Wren is doing. `idle` and `sleep` are resting states; the others play once and return to rest. */
export type WrenMood = "idle" | "hello" | "talk" | "happy" | "nod" | "worried" | "sleep" | "fly";

/** How long each passing mood lasts, in milliseconds. `talk` lasts until it is stopped. */
export const MOOD_MS: Record<Exclude<WrenMood, "idle" | "sleep" | "talk">, number> = {
  hello: 1300,
  happy: 1700,
  nod: 900,
  worried: 2000,
  fly: 700,
};

/** Wren dozes off after this long without a pointer move, click or key press. */
export const SLEEP_AFTER_MS = 90_000;

const EVENT = "tenderline:wren";

/** Lets any screen make Wren react, for example after a bulk action. */
export function wrenReact(mood: WrenMood): void {
  window.dispatchEvent(new CustomEvent<WrenMood>(EVENT, { detail: mood }));
}

/**
 * Wren's mood. Passing moods return to idle on their own; a newer reaction replaces an older one. With
 * `calm` (reduced motion or the guide's own setting) Wren never falls asleep, so nothing drifts on screen.
 * `awake` keeps Wren awake, for example while the panel is open.
 */
export function useWrenMood({ calm, awake }: { calm: boolean; awake: boolean }) {
  const [mood, setMood] = useState<WrenMood>("idle");
  const back = useRef<number | undefined>(undefined);

  const play = useCallback((next: WrenMood) => {
    window.clearTimeout(back.current);
    setMood(next);
    if (next !== "idle" && next !== "sleep" && next !== "talk") {
      back.current = window.setTimeout(() => setMood("idle"), MOOD_MS[next]);
    }
  }, []);

  useEffect(() => () => window.clearTimeout(back.current), []);

  // Doze after a while without input; any input wakes Wren up again.
  useEffect(() => {
    if (calm || awake) return;
    let timer = window.setTimeout(() => setMood((m) => (m === "idle" ? "sleep" : m)), SLEEP_AFTER_MS);
    const wake = () => {
      window.clearTimeout(timer);
      setMood((m) => (m === "sleep" ? "idle" : m));
      timer = window.setTimeout(() => setMood((m) => (m === "idle" ? "sleep" : m)), SLEEP_AFTER_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, [calm, awake]);

  // Reactions sent from elsewhere with wrenReact().
  useEffect(() => {
    const onReact = (event: Event) => play((event as CustomEvent<WrenMood>).detail);
    window.addEventListener(EVENT, onReact);
    return () => window.removeEventListener(EVENT, onReact);
  }, [play]);

  return { mood, play };
}

/** The mutation keys Wren listens for (set in src/api/hooks.ts and the To decide bulk bar). */
export const WREN_KEYS = { approve: "approve", editApprove: "edit-approve", reject: "reject", status: "set-status", bulk: "bulk-decide" } as const;

/** Which reaction a finished request deserves, if any. Exported for tests. */
export function reactionFor(key: unknown, ok: boolean, variables: unknown): WrenMood | null {
  const name = Array.isArray(key) ? key[0] : undefined;
  if (typeof name !== "string" || !Object.values(WREN_KEYS).includes(name as never)) return null;
  if (!ok) return "worried";
  if (name === WREN_KEYS.approve || name === WREN_KEYS.editApprove) return "happy";
  if (name === WREN_KEYS.reject) return "nod";
  if (name === WREN_KEYS.bulk) return variables === "approve" ? "happy" : "nod";
  if (name === WREN_KEYS.status) {
    const status = (variables as { status?: string } | undefined)?.status;
    return status === "won" ? "happy" : status === "lost" || status === "no_bid" ? "nod" : null;
  }
  return null;
}

/**
 * Wren reacts when a decision or a pipeline move finishes, and looks worried when one fails. Only when
 * `enabled` ("Lively Wren"): by default Wren does not move unless someone asks it for help.
 */
export function useWrenReactions(play: (mood: WrenMood) => void, enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const { type } = event.action;
      if (type !== "success" && type !== "error") return;
      const mood = reactionFor(event.mutation.options.mutationKey, type === "success", event.mutation.state.variables);
      if (mood) play(mood);
    });
  }, [queryClient, play, enabled]);
}
