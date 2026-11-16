import { afterEach, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDismissed, resetTips } from "./first-run";

afterEach(() => { vi.restoreAllMocks(); resetTips(); });

it("keeps guide preferences usable when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { result } = renderHook(() => useDismissed("guide.hidden"));
  act(() => result.current[1](true));
  expect(result.current[0]).toBe(true);
  act(() => result.current[1](false));
  expect(result.current[0]).toBe(false);
});
