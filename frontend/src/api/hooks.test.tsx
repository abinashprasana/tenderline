import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useProposals } from "./hooks";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const proposal = (n: number) => ({ id: `p${n}`, notice_id: `n${n % 150}`, status: "pending" });

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => vi.restoreAllMocks());

describe("useProposals", () => {
  it("follows the cursor so every waiting suggestion is loaded, not only the first 200", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL((input as Request).url);
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return json({ items: Array.from({ length: 200 }, (_, i) => proposal(i)), next_cursor: "page2" });
      if (cursor === "page2") return json({ items: Array.from({ length: 118 }, (_, i) => proposal(200 + i)), next_cursor: null });
      throw new Error(`unexpected cursor ${cursor}`);
    });
    const { result } = renderHook(() => useProposals("org", { status: "pending" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items).toHaveLength(318);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new URL((fetchMock.mock.calls[1]![0] as Request).url);
    expect(second.searchParams.get("status")).toBe("pending");
    expect(second.searchParams.get("cursor")).toBe("page2");
  });

  it("asks for one page only when a limit is given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ items: [proposal(1)], next_cursor: "more" }));
    const { result } = renderHook(() => useProposals("org", { status: "pending", limit: 1 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
