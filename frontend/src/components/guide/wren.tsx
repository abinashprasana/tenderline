import { motion, useAnimate, useMotionValue, useSpring, useTransform, type TargetAndTransition, type Variants } from "motion/react";
import { useEffect, useRef } from "react";

import type { WrenMood } from "./use-wren";

/*
 * Wren, the Tenderline owl. One inline SVG, coloured from the theme (body and face follow --accent) with
 * fixed colours for eyes, beak and feet so the character stays recognisable in both themes.
 * Every moving part is its own group so moods can combine: the body breathes, the head nods, the wings
 * wave, the eyes blink and follow the pointer. With `calm`, each mood is a still pose.
 */

const BODY = "var(--accent)";
const WING = "color-mix(in oklch, var(--accent) 72%, black)";
const FACE = "color-mix(in oklch, var(--accent) 32%, white)";
const INK = "#10211d";
const EYE = "#fbfdfc";
const BEAK = "#f2a33a";
const BEAK_DARK = "#cf7d27";

type Groups = "whole" | "head" | "wingL" | "wingR" | "eyes" | "round" | "happy" | "brows" | "beak" | "sparkle";

/** Final poses, used as-is when calm and as the resting end of each live animation. */
const POSE: Record<Groups, Partial<Record<WrenMood, Record<string, number>>> & { idle: Record<string, number> }> = {
  whole: { idle: { y: 0, scale: 1, rotate: 0, x: 0 } },
  head: { idle: { rotate: 0, y: 0 }, sleep: { rotate: 9, y: 1.5 }, worried: { rotate: -4, y: 0 } },
  wingL: { idle: { rotate: 0 } },
  wingR: { idle: { rotate: 0 } },
  eyes: { idle: { scaleY: 1 }, sleep: { scaleY: 0.12 } },
  round: { idle: { opacity: 1 }, happy: { opacity: 0 } },
  happy: { idle: { opacity: 0 }, happy: { opacity: 1 } },
  brows: { idle: { opacity: 0, y: 0 }, worried: { opacity: 1, y: -0.5 } },
  beak: { idle: { y: 0 } },
  sparkle: { idle: { opacity: 0, scale: 0.4 } },
};

/** Live motion on top of the poses: keyframes that end at the pose, some looping. */
const LIVE: Record<Groups, Partial<Record<WrenMood, TargetAndTransition>>> = {
  whole: {
    idle: { scale: [1, 1.025, 1], transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" } },
    talk: { scale: [1, 1.02, 1], transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" } },
    sleep: { scale: [1, 1.015, 1], transition: { duration: 4.6, repeat: Infinity, ease: "easeInOut" } },
    hello: { y: [0, -7, 0, -3, 0], transition: { duration: 0.9, ease: "easeOut" } },
    happy: { y: [0, -5, 0, -5, 0], scale: [1, 1.06, 1, 1.06, 1], transition: { duration: 1.1 } },
    worried: { x: [0, -1.2, 1.2, -1.2, 1.2, 0], transition: { duration: 0.5 } },
    fly: { y: [0, -9, -6, 0], rotate: [0, -6, 6, 0], transition: { duration: 0.7 } },
    nod: { y: [0, 1, 0], transition: { duration: 0.5 } },
  },
  head: {
    nod: { rotate: [0, 0, 0], y: [0, 3, 0, 2, 0], transition: { duration: 0.8 } },
    hello: { rotate: [0, -8, 6, 0], transition: { duration: 0.9 } },
    sleep: { rotate: 9, y: [1.5, 2.2, 1.5], transition: { duration: 4.6, repeat: Infinity, ease: "easeInOut" } },
  },
  wingL: {
    hello: { rotate: [0, 50, 25, 50, 25, 0], transition: { duration: 1.1 } },
    happy: { rotate: [0, 40, 0, 40, 0], transition: { duration: 1.1 } },
    fly: { rotate: [0, 45, 0, 45, 0], transition: { duration: 0.7 } },
  },
  wingR: {
    happy: { rotate: [0, -40, 0, -40, 0], transition: { duration: 1.1 } },
    fly: { rotate: [0, -45, 0, -45, 0], transition: { duration: 0.7 } },
  },
  eyes: {},
  round: {},
  happy: {},
  brows: {},
  beak: { talk: { y: [0, 1.6, 0], transition: { duration: 0.28, repeat: Infinity } } },
  sparkle: {
    happy: { opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 1, 0.6], transition: { duration: 1.4, times: [0, 0.25, 0.7, 1] } },
  },
};

function variants(group: Groups, calm: boolean, quiet: boolean): Variants {
  const out: Variants = {};
  const moods: WrenMood[] = ["idle", "hello", "talk", "happy", "nod", "worried", "sleep", "fly"];
  for (const mood of moods) {
    const pose = { ...POSE[group].idle, ...POSE[group][mood] };
    // Quiet: resting moods are held poses, so nothing moves until Wren is asked to do something.
    const live = calm || (quiet && (mood === "idle" || mood === "sleep")) ? undefined : LIVE[group][mood];
    out[mood] = live ? { ...pose, ...live } : { ...pose, transition: { duration: calm ? 0 : 0.25 } };
  }
  return out;
}

/**
 * `quiet` keeps a resting Wren still apart from a slow blink; `track` lets the eyes follow the pointer.
 * The guide turns both on only while someone is using it, unless "Lively Wren" is switched on.
 */
export function Wren({
  mood,
  size = 36,
  calm = false,
  track = true,
  quiet = false,
}: {
  mood: WrenMood;
  size?: number;
  calm?: boolean;
  track?: boolean;
  quiet?: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const [blinkScope, animate] = useAnimate<SVGGElement>();
  const gazeX = useMotionValue(0);
  const gazeY = useMotionValue(0);
  const springX = useSpring(gazeX, { stiffness: 260, damping: 22 });
  const springY = useSpring(gazeY, { stiffness: 260, damping: 22 });
  const pupilX = useTransform(springX, (v) => v * 2.3);
  const pupilY = useTransform(springY, (v) => v * 1.8);
  const tilt = useTransform(springX, (v) => v * 5);

  const asleep = mood === "sleep";
  const gazing = track && !calm && !asleep;

  // Eyes follow the pointer: one listener, throttled to one update per frame, no React renders.
  useEffect(() => {
    if (!gazing) {
      gazeX.set(0);
      gazeY.set(0);
      return;
    }
    let frame = 0;
    let last = { x: 0, y: 0 };
    const onMove = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = root.current?.getBoundingClientRect();
        if (!box || document.hidden) return;
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        gazeX.set(clamp((last.x - (box.left + box.width / 2)) / 260));
        gazeY.set(clamp((last.y - (box.top + box.height / 2)) / 260));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [gazing, gazeX, gazeY]);

  // Blink every few seconds, at random, and now and then glance somewhere else.
  useEffect(() => {
    if (calm || asleep || mood === "happy") return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (blinkScope.current) void animate(blinkScope.current, { scaleY: [1, 0.08, 1] }, { duration: 0.2 });
          if (!quiet && Math.random() < 0.3) {
            gazeX.set((Math.random() - 0.5) * 1.2);
            gazeY.set((Math.random() - 0.5) * 0.6);
          }
          schedule();
        },
        quiet ? 6000 + Math.random() * 4000 : 2800 + Math.random() * 3400,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [calm, quiet, asleep, mood, animate, blinkScope, gazeX, gazeY]);

  const v = (group: Groups) => variants(group, calm, quiet);
  const g = { initial: false as const, animate: mood };

  return (
    <motion.svg
      ref={root}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className="shrink-0 overflow-visible"
      aria-hidden
      data-wren="2d"
      data-mood={mood}
      data-calm={calm || undefined}
    >
      <motion.g {...g} variants={v("whole")} style={{ originX: 0.5, originY: 1 }} data-part="whole">
        {/* feet */}
        <ellipse cx="26.5" cy="57.2" rx="3.4" ry="1.7" fill={BEAK} />
        <ellipse cx="37.5" cy="57.2" rx="3.4" ry="1.7" fill={BEAK} />
        {/* body and belly */}
        <path d="M32 10C19.5 10 12.5 19.5 12.5 32.5C12.5 46.5 20.5 57 32 57C43.5 57 51.5 46.5 51.5 32.5C51.5 19.5 44.5 10 32 10Z" fill={BODY} />
        <ellipse cx="32" cy="45" rx="11.5" ry="10" fill={FACE} />
        <path d="M26.5 41.5l2 1.8 2-1.8M33.5 41.5l2 1.8 2-1.8M30 46.5l2 1.8 2-1.8" stroke={WING} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.55" />
        {/* the tender it is holding, tucked under the right wing */}
        <g transform="translate(42.5 40.5) rotate(14)">
          <rect width="10" height="12.5" rx="1.6" fill={EYE} stroke={INK} strokeOpacity="0.25" strokeWidth="0.6" />
          <path d="M2.2 3.2h5.6M2.2 5.7h5.6M2.2 8.2h3.6" stroke={BODY} strokeWidth="1.1" strokeLinecap="round" />
        </g>
        {/* wings */}
        <motion.path {...g} variants={v("wingL")} style={{ originX: 0.7, originY: 0.05 }} d="M14 29.5C7.5 35.5 8 46 15.5 51.5C18 44.5 18 36.5 14 29.5Z" fill={WING} />
        <motion.path {...g} variants={v("wingR")} style={{ originX: 0.3, originY: 0.05 }} d="M50 29.5C56.5 35.5 56 46 48.5 51.5C46 44.5 46 36.5 50 29.5Z" fill={WING} />

        {/* head: nods with the mood, tilts toward the pointer */}
        <motion.g {...g} variants={v("head")} style={{ originX: 0.5, originY: 0.9 }}>
          <motion.g style={{ rotate: tilt, originX: 0.5, originY: 0.9 }}>
            <path d="M15.5 20L13 6.5L25.5 12.5Z" fill={BODY} />
            <path d="M48.5 20L51 6.5L38.5 12.5Z" fill={BODY} />
            <circle cx="24.5" cy="27" r="9.6" fill={FACE} />
            <circle cx="39.5" cy="27" r="9.6" fill={FACE} />

            <motion.g {...g} variants={v("eyes")} style={{ originX: 0.5, originY: 0.5 }}>
              <g ref={blinkScope} style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}>
                <motion.g {...g} variants={v("round")}>
                  <circle cx="24.5" cy="27" r="6.6" fill={EYE} />
                  <circle cx="39.5" cy="27" r="6.6" fill={EYE} />
                  <motion.g style={{ x: pupilX, y: pupilY }}>
                    <circle cx="24.5" cy="27" r="3.5" fill={INK} />
                    <circle cx="39.5" cy="27" r="3.5" fill={INK} />
                    <circle cx="23.3" cy="25.8" r="1.15" fill={EYE} />
                    <circle cx="38.3" cy="25.8" r="1.15" fill={EYE} />
                  </motion.g>
                </motion.g>
              </g>
            </motion.g>
            {/* happy, squinting eyes */}
            <motion.path {...g} variants={v("happy")} d="M19 28.5Q24.5 22 30 28.5M34 28.5Q39.5 22 45 28.5" stroke={INK} strokeWidth="2.4" strokeLinecap="round" fill="none" />
            {/* worried brows */}
            <motion.path {...g} variants={v("brows")} d="M18.5 19.5L27.5 17M45.5 19.5L36.5 17" stroke={INK} strokeWidth="2" strokeLinecap="round" fill="none" />

            <path d="M29 32.2h6l-3 5.2Z" fill={BEAK} />
            <motion.path {...g} variants={v("beak")} d="M30.6 34.6h2.8l-1.4 3.3Z" fill={BEAK_DARK} />
          </motion.g>
        </motion.g>
      </motion.g>

      {/* sparkles when something good happened */}
      <motion.g {...g} variants={v("sparkle")} style={{ originX: 0.5, originY: 0.5 }} fill="var(--soon)">
        <path d="M7 15l1.2 2.8 2.8 1.2-2.8 1.2L7 23l-1.2-2.8L3 19l2.8-1.2Z" />
        <path d="M57 10l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1Z" />
        <path d="M59 33l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8Z" />
      </motion.g>

      {/* asleep */}
      {asleep ? (
        calm ? (
          <text x="50" y="12" fontSize="9" fontWeight="700" fill="var(--muted)">
            z
          </text>
        ) : (
          [0, 1, 2].map((i) => (
            <motion.text
              key={i}
              x="48"
              y="14"
              fontSize={7 + i * 1.5}
              fontWeight="700"
              fill="var(--muted)"
              initial={{ opacity: 0, x: 0, y: 0 }}
              animate={{ opacity: [0, 1, 0], x: [0, 4, 8], y: [0, -8, -16] }}
              transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }}
            >
              z
            </motion.text>
          ))
        )
      ) : null}
    </motion.svg>
  );
}
