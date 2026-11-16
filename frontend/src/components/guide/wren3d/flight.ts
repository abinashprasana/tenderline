import type { WrenMood } from "../use-wren";

/** The square canvas Wren is drawn in, in CSS pixels, and where its feet sit inside it. */
export const STAGE_SIZE = 132;
/** Fraction of the canvas height between the feet and the bottom edge. */
export const FEET_FROM_BOTTOM = 0.1;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the canvas goes so that Wren's feet land on the top edge of a box. `along` picks the spot on
 * that edge: a number of pixels from the left, or the middle when left out. The feet overlap the edge
 * by a few pixels so the claws read as gripping it. Kept inside the viewport.
 */
export function perchPosition(box: Box, viewport: { width: number; height: number }, along?: number): Point {
  const footX = box.left + (along === undefined ? box.width / 2 : Math.min(along, box.width / 2));
  const footY = box.top + 4;
  const x = footX - STAGE_SIZE / 2;
  const y = footY - STAGE_SIZE * (1 - FEET_FROM_BOTTOM);
  return {
    x: Math.max(0, Math.min(viewport.width - STAGE_SIZE, x)),
    y: Math.max(0, Math.min(viewport.height - STAGE_SIZE, y)),
  };
}

/** How big Wren is at home, inside its button, compared with its size on a perch. */
export const HOME_SCALE = 0.42;

/**
 * Where the canvas goes so that Wren, shrunk to HOME_SCALE, stands inside its launcher button on the
 * left, feet just above the button's bottom edge, so it never covers the page. The canvas scales from
 * its feet, so the feet stay where they are put whatever the scale.
 */
export function homePosition(box: Box): Point {
  const footX = box.left + 34;
  const footY = box.top + box.height - 7;
  return { x: footX - STAGE_SIZE / 2, y: footY - STAGE_SIZE * (1 - FEET_FROM_BOTTOM) };
}

/** True when a box is at least partly on screen, so there is something to perch on. */
export function onScreen(box: Box, viewport: { width: number; height: number }): boolean {
  return box.width > 0 && box.height > 0 && box.top + box.height > 0 && box.top < viewport.height && box.left + box.width > 0 && box.left < viewport.width;
}

/** Ease in and out, so take-off and landing are gentle. */
export function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 2 * c * c : 1 - (-2 * c + 2) ** 2 / 2;
}

/** A point on the flight path: a curve that rises above the straight line between start and end. */
export function arc(from: Point, to: Point, t: number): Point {
  const k = ease(t);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const lift = Math.min(140, 40 + distance * 0.18);
  const control = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift };
  const a = (1 - k) ** 2;
  const b = 2 * (1 - k) * k;
  const c = k ** 2;
  return { x: a * from.x + b * control.x + c * to.x, y: a * from.y + b * control.y + c * to.y };
}

/** How long a flight takes, in milliseconds: longer for longer trips, within sensible limits. */
export function flightMs(from: Point, to: Point): number {
  return Math.max(520, Math.min(1250, Math.hypot(to.x - from.x, to.y - from.y) * 1.25));
}

/** Which way Wren turns while flying, in radians: toward the direction of travel. */
export function heading(from: Point, to: Point): number {
  const dx = to.x - from.x;
  return Math.abs(dx) < 8 ? 0 : Math.sign(dx) * 0.95;
}

export type WrenPlace = "home" | "flying" | "perch";

/**
 * Which animation clip to play, and whether it loops, for a mood in a place. At home Wren holds still
 * (the "still" clip only blinks) unless `lively` is on; on a perch it was asked to come, so it sits.
 */
export function clipFor(mood: WrenMood, place: WrenPlace, lively = false): { clip: string; loop: boolean } {
  if (place === "flying" || mood === "fly") return { clip: "fly", loop: true };
  switch (mood) {
    case "sleep":
      return { clip: "sleep", loop: true };
    case "talk":
      return { clip: "call", loop: true };
    case "hello":
    case "happy":
      return { clip: "jump", loop: false };
    case "nod":
      return { clip: "eat", loop: false };
    case "worried":
      return { clip: "hit", loop: false };
    default:
      return { clip: place === "perch" ? "sit" : lively ? "idle" : "still", loop: true };
  }
}

/** Whether to draw the 3D owl at all. Otherwise the flat Wren is used. */
export function wants3D(input: { calm: boolean; flat: boolean; width: number; failed: boolean }): boolean {
  return !input.calm && !input.flat && !input.failed && input.width >= 640;
}
