import { describe, expect, it } from "vitest";

import { arc, clipFor, ease, FEET_FROM_BOTTOM, flightMs, heading, onScreen, perchPosition, STAGE_SIZE, wants3D } from "./flight";

const viewport = { width: 1280, height: 720 };

describe("perching", () => {
  it("puts the feet on the top edge of a box, in the middle or a set distance along it", () => {
    const box = { left: 400, top: 300, width: 200, height: 80 };
    const middle = perchPosition(box, viewport);
    expect(middle.x + STAGE_SIZE / 2).toBe(500);
    expect(middle.y + STAGE_SIZE * (1 - FEET_FROM_BOTTOM)).toBeCloseTo(304);
    expect(perchPosition(box, viewport, 54).x + STAGE_SIZE / 2).toBe(454);
    // never further along than the middle of a narrow box
    expect(perchPosition({ ...box, width: 60 }, viewport, 54).x + STAGE_SIZE / 2).toBe(430);
  });

  it("stays inside the window", () => {
    expect(perchPosition({ left: -40, top: 10, width: 60, height: 20 }, viewport)).toEqual({ x: 0, y: 0 });
    const corner = perchPosition({ left: 1270, top: 715, width: 40, height: 40 }, viewport);
    expect(corner.x).toBe(viewport.width - STAGE_SIZE);
    expect(corner.y).toBeLessThanOrEqual(viewport.height - STAGE_SIZE);
  });

  it("knows when there is nothing on screen to perch on", () => {
    expect(onScreen({ left: 10, top: 10, width: 50, height: 20 }, viewport)).toBe(true);
    expect(onScreen({ left: 10, top: -200, width: 50, height: 20 }, viewport)).toBe(false);
    expect(onScreen({ left: 10, top: 900, width: 50, height: 20 }, viewport)).toBe(false);
    expect(onScreen({ left: 10, top: 10, width: 0, height: 0 }, viewport)).toBe(false);
  });
});

describe("flight", () => {
  const from = { x: 1000, y: 600 };
  const to = { x: 200, y: 100 };

  it("starts and ends exactly at the two points and rises above the straight line between", () => {
    expect(arc(from, to, 0)).toEqual(from);
    expect(arc(from, to, 1)).toEqual(to);
    const mid = arc(from, to, 0.5);
    expect(mid.y).toBeLessThan((from.y + to.y) / 2);
    expect(mid.x).toBeCloseTo(600);
  });

  it("eases in and out, takes longer for longer trips, and turns toward where it is going", () => {
    expect([ease(-1), ease(0), ease(0.5), ease(1), ease(2)]).toEqual([0, 0, 0.5, 1, 1]);
    expect(flightMs(from, { x: 990, y: 600 })).toBe(520);
    expect(flightMs(from, to)).toBeGreaterThan(900);
    expect(flightMs({ x: 0, y: 0 }, { x: 4000, y: 3000 })).toBe(1250);
    expect(heading(from, to)).toBeLessThan(0);
    expect(heading(to, from)).toBeGreaterThan(0);
    expect(heading(from, { x: 1002, y: 100 })).toBe(0);
  });
});

describe("clips and the 3D switch", () => {
  it("picks a clip for each mood and place", () => {
    // At home Wren holds still unless it is lively.
    expect(clipFor("idle", "home")).toEqual({ clip: "still", loop: true });
    expect(clipFor("idle", "home", true)).toEqual({ clip: "idle", loop: true });
    expect(clipFor("idle", "perch", true)).toEqual({ clip: "sit", loop: true });
    expect(clipFor("idle", "perch")).toEqual({ clip: "sit", loop: true });
    expect(clipFor("happy", "flying")).toEqual({ clip: "fly", loop: true });
    expect(clipFor("talk", "perch")).toEqual({ clip: "call", loop: true });
    expect(clipFor("happy", "home")).toEqual({ clip: "jump", loop: false });
    expect(clipFor("nod", "home").clip).toBe("eat");
    expect(clipFor("worried", "perch").clip).toBe("hit");
    expect(clipFor("sleep", "home").clip).toBe("sleep");
  });

  it("uses the flat owl on small screens, under reduced motion, when switched off or when 3D failed", () => {
    const ok = { calm: false, flat: false, width: 1280, failed: false };
    expect(wants3D(ok)).toBe(true);
    expect(wants3D({ ...ok, width: 390 })).toBe(false);
    expect(wants3D({ ...ok, calm: true })).toBe(false);
    expect(wants3D({ ...ok, flat: true })).toBe(false);
    expect(wants3D({ ...ok, failed: true })).toBe(false);
  });
});
