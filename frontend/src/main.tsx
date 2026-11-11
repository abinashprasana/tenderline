import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { setExpiredHandler } from "./api/client";
import { ApiError, describeError } from "./api/errors";
import { makeRouter } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // 4xx answers will not change on retry; network blips and 5xx get two more tries.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.state.data !== undefined && !(error instanceof ApiError && error.status === 401)) {
        toast.error(describeError(error), { id: `query-${query.queryHash}` });
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _vars, _context, mutation) => {
      if (mutation.options.meta?.quiet) return;
      if (error instanceof ApiError && error.status === 401) return;
      toast.error(describeError(error));
    },
  }),
});

const router = makeRouter(queryClient);

setExpiredHandler(() => {
  queryClient.clear();
  const here = router.state.location.href;
  if (!here.startsWith("/sign-in")) void router.navigate({ to: "/sign-in", search: { next: here } });
});

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: { quiet?: boolean };
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
