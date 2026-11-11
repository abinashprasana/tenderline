import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";

export function NotFound() {
  return (
    <main className="app-backdrop grid min-h-dvh place-items-center px-4">
      <EmptyState
        icon={<Compass className="size-5" />}
        title="This page does not exist"
        action={
          <Button asChild variant="primary">
            <Link to="/app">Go to Tenderline</Link>
          </Button>
        }
      >
        The link may be old, or the item was removed.
      </EmptyState>
    </main>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="grid min-h-[60dvh] place-items-center px-4">
      <ErrorState error={error} onRetry={reset} />
    </main>
  );
}
