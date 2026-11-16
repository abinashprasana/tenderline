import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOOD_MS, reactionFor, SLEEP_AFTER_MS, useWrenMood, wrenReact } from "./use-wren";

describe("Wren's mood", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a passing mood, then goes back to idle; a newer reaction replaces an older one", () => {
    const { result } = renderHook(() => useWrenMood({ calm: false, awake: true }));
    act(() => result.current.play("happy"));
    expect(result.current.mood).toBe("happy");
    act(() => vi.advanceTimersByTime(MOOD_MS.happy - 100));
    act(() => result.current.play("worried"));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.mood).toBe("worried");
    act(() => vi.advanceTimersByTime(MOOD_MS.worried));
    expect(result.current.mood).toBe("idle");
  });

  it("dozes off without input, wakes on input, and never sleeps when calm or awake", () => {
    const sleepy = renderHook(() => useWrenMood({ calm: false, awake: false }));
    act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS + 10));
    expect(sleepy.result.current.mood).toBe("sleep");
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(sleepy.result.current.mood).toBe("idle");

    const calm = renderHook(() => useWrenMood({ calm: true, awake: false }));
    const open = renderHook(() => useWrenMood({ calm: false, awake: true }));
    act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS * 2));
    expect(calm.result.current.mood).toBe("idle");
    expect(open.result.current.mood).toBe("idle");
  });

  it("reacts to wrenReact from anywhere", () => {
    const { result } = renderHook(() => useWrenMood({ calm: false, awake: true }));
    act(() => wrenReact("nod"));
    expect(result.current.mood).toBe("nod");
  });
});

describe("reactions to finished requests", () => {
  it("is happy about approvals and wins, nods at rejections, worries about failures, ignores the rest", () => {
    expect(reactionFor(["approve"], true, {})).toBe("happy");
    expect(reactionFor(["edit-approve"], true, {})).toBe("happy");
    expect(reactionFor(["reject"], true, {})).toBe("nod");
    expect(reactionFor(["bulk-decide"], true, "approve")).toBe("happy");
    expect(reactionFor(["bulk-decide"], true, "reject")).toBe("nod");
    expect(reactionFor(["set-status"], true, { status: "won" })).toBe("happy");
    expect(reactionFor(["set-status"], true, { status: "bid" })).toBeNull();
    expect(reactionFor(["approve"], false, {})).toBe("worried");
    expect(reactionFor(["patch-org"], false, {})).toBeNull();
    expect(reactionFor(undefined, true, {})).toBeNull();
  });
});
