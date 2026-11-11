import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api, unwrap } from "@/api/client";
import { describeError } from "@/api/errors";
import { safeNext, startSession } from "@/auth/session";
import { Logo } from "@/components/logo";
import { Button, Spinner } from "@/components/ui/button";

import { NEXT_KEY } from "./sign-in";

/**
 * The OAuth state is single-use, so the code exchange must happen exactly once even though React's
 * StrictMode mounts effects twice in development. One promise per code, shared by every mount.
 */
const exchanges = new Map<string, Promise<void>>();

function exchange(code: string, state: string): Promise<void> {
  let pending = exchanges.get(code);
  if (!pending) {
    pending = unwrap(api.GET("/v1/auth/github/callback", { params: { query: { code, state } } })).then((token) => {
      startSession(token.access_token, token.user_id, token.login);
    });
    exchanges.set(code, pending);
  }
  return pending;
}

const GITHUB_ERRORS: Record<string, string> = {
  access_denied: "You cancelled the GitHub sign-in.",
};

export function AuthCallback() {
  const { code, state, error: githubError } = useSearch({ from: "/auth/callback" });
  const navigate = useNavigate();
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const error = githubError
    ? (GITHUB_ERRORS[githubError] ?? "GitHub could not complete the sign-in.")
    : !code || !state
      ? "This sign-in link is incomplete. Start sign-in again."
      : exchangeError;

  useEffect(() => {
    if (githubError || !code || !state) return;
    let cancelled = false;
    exchange(code, state)
      .then(() => {
        if (cancelled) return;
        let next = "/app";
        try {
          next = safeNext(sessionStorage.getItem(NEXT_KEY));
          sessionStorage.removeItem(NEXT_KEY);
        } catch {
          /* storage blocked */
        }
        void navigate({ to: next, replace: true });
      })
      .catch((caught) => !cancelled && setExchangeError(describeError(caught)));
    return () => {
      cancelled = true;
    };
  }, [code, state, githubError, navigate]);

  return (
    <main className="app-backdrop grid min-h-dvh place-items-center px-4">
      <section className="glass flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl p-8 text-center">
        <Logo />
        {error ? (
          <>
            <p role="alert" className="text-sm text-muted">
              {error}
            </p>
            <Button asChild variant="primary">
              <Link to="/sign-in">Back to sign-in</Link>
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner /> Signing you in…
          </p>
        )}
      </section>
    </main>
  );
}
