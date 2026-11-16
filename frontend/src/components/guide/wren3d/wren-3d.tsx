import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import type { WrenMood } from "../use-wren";

import { arc, clipFor, flightMs, heading, HOME_SCALE, homePosition, onScreen, perchPosition, STAGE_SIZE, type Point, type WrenPlace } from "./flight";
import type { WrenStage } from "./stage";

/**
 * Wren in 3D. A small canvas that sits on the launcher (home) or flies to a perch: the top edge of the
 * guide panel, or a control Wren is pointing out. It follows its perch when the page scrolls or resizes
 * and flies home when the perch goes away. Decorative: the launcher button stays the real control, so
 * this is hidden from assistive technology and lets every click through to what is underneath.
 */
export function Wren3D({
  mood,
  lively,
  attentive,
  home,
  perch,
  onReady,
  onFail,
  onPerchLost,
}: {
  mood: WrenMood;
  /** Sway and look around while resting. Off: Wren holds still and only blinks. */
  lively: boolean;
  /** Turn the head toward the pointer: while the guide is in use, or always when lively. */
  attentive: boolean;
  home: HTMLElement | null;
  /** Where to sit: an element, or a CSS selector looked up every frame (screens re-render). `null` means home. */
  perch: HTMLElement | string | null;
  onReady: () => void;
  onFail: () => void;
  onPerchLost: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<WrenStage | null>(null);
  const [ready, setReady] = useState(false);
  const [place, setPlace] = useState<WrenPlace>("home");

  // Latest values for the frame loop, without restarting it.
  const live = useRef({ home, perch, onPerchLost });
  useEffect(() => {
    live.current = { home, perch, onPerchLost };
  });

  // Load three.js and the owl on demand.
  useEffect(() => {
    let cancelled = false;
    let made: WrenStage | null = null;
    void (async () => {
      try {
        const { WrenStage } = await import("./stage");
        if (cancelled || !canvas.current) return;
        made = new WrenStage(canvas.current);
        await made.load();
        if (cancelled) return;
        stage.current = made;
        setReady(true);
        onReady();
      } catch {
        if (!cancelled) onFail();
      }
    })();
    return () => {
      cancelled = true;
      made?.dispose();
      stage.current = null;
    };
    // Load once: the callbacks only report the outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position: follow the current target every frame, flying whenever the target changes.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let position: Point | null = null;
    let target: HTMLElement | null | undefined;
    let flight: { from: Point; fromScale: number; start: number; ms: number } | null = null;
    let size = HOME_SCALE;
    let shown: WrenPlace = "home";
    let missingSince = 0;

    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const el = wrap.current;
      const { home: homeEl, perch: perchEl, onPerchLost: lost } = live.current;
      if (!el || !homeEl) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };

      let goal = typeof perchEl === "string" ? document.querySelector<HTMLElement>(perchEl) : perchEl;
      if (perchEl && (!goal || !goal.isConnected || !onScreen(goal.getBoundingClientRect(), viewport))) {
        // Gone for a moment (a re-render, a scroll): wait at home, and give up only if it stays away.
        goal = null;
        missingSince ||= now;
        if (now - missingSince > 2000) {
          missingSince = 0;
          lost();
        }
      } else {
        missingSince = 0;
      }
      const dest = goal
        ? perchPosition(goal.getBoundingClientRect(), viewport, Number(goal.dataset.perchX) || undefined)
        : homePosition(homeEl.getBoundingClientRect());
      const destScale = goal ? 1 : HOME_SCALE;

      if (position === null) position = dest;
      if (target !== goal) {
        if (target !== undefined) flight = { from: position, fromScale: size, start: now, ms: flightMs(position, dest) };
        target = goal;
      }

      let next: WrenPlace = goal ? "perch" : "home";
      let scale = destScale;
      if (flight) {
        const t = (now - flight.start) / flight.ms;
        if (t >= 1) {
          flight = null;
          position = dest;
          stage.current?.face(0);
        } else {
          position = arc(flight.from, dest, t);
          // Grows or shrinks on the way, with a little extra in the middle of the flight for depth.
          scale = flight.fromScale + (destScale - flight.fromScale) * t + 0.14 * Math.sin(Math.PI * t);
          stage.current?.face(heading(flight.from, dest));
          next = "flying";
        }
      } else {
        position = dest;
      }
      size = scale;
      el.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`;
      if (next !== shown) {
        shown = next;
        setPlace(next);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // The clip follows the mood and where Wren is.
  useEffect(() => {
    if (!ready) return;
    const { clip, loop } = clipFor(mood, place, lively);
    stage.current?.play(clip, loop);
  }, [ready, mood, place, lively]);

  // The head turns toward the pointer, but only while Wren is paying attention.
  useEffect(() => {
    if (!ready) return;
    if (!attentive) {
      stage.current?.lookAt(0, 0);
      return;
    }
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = wrap.current?.getBoundingClientRect();
        if (!box || !stage.current) return;
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        stage.current.lookAt(clamp((event.clientX - (box.left + box.width / 2)) / 320), clamp((event.clientY - (box.top + box.height / 2)) / 320));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [ready, attentive]);

  return (
    <div
      ref={wrap}
      aria-hidden
      data-wren="3d"
      data-mood={mood}
      data-place={place}
      data-ready={ready || undefined}
      className={cn("wren-3d", ready ? "opacity-100" : "opacity-0")}
      style={{ width: STAGE_SIZE, height: STAGE_SIZE }}
    >
      <canvas ref={canvas} width={STAGE_SIZE} height={STAGE_SIZE} className="size-full" />
      <span className={cn("wren-3d-shadow", place === "flying" && "opacity-0")} />
    </div>
  );
}
