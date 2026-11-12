import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState, type FormEvent } from "react";

import { api, unwrap } from "@/api/client";
import { describeError } from "@/api/errors";
import { useMetadata } from "@/api/hooks";
import { startSession, safeNext } from "@/auth/session";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

export const NEXT_KEY = "tenderline.next";

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function SignIn() {
  const { next } = useSearch({ from: "/sign-in" });
  const navigate = useNavigate();
  const metadata = useMetadata();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"github" | "dev" | null>(null);
  const [devLogin, setDevLogin] = useState("");

  async function withGitHub() {
    setError(null);
    setPending("github");
    try {
      // The API sets a short-lived cookie bound to this browser, then we hand over to GitHub.
      const { authorize_url } = await unwrap(api.GET("/v1/auth/github/login"));
      try {
        sessionStorage.setItem(NEXT_KEY, safeNext(next));
      } catch {
        /* storage blocked: land on /app */
      }
      window.location.assign(authorize_url);
    } catch (caught) {
      setError(describeError(caught));
      setPending(null);
    }
  }

  async function withDevAccount(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("dev");
    try {
      const token = await unwrap(api.POST("/v1/auth/dev-token", { body: { login: devLogin.trim(), role: "owner" } }));
      startSession(token.access_token, token.user_id, token.login);
      await navigate({ to: safeNext(next) });
    } catch (caught) {
      setError(describeError(caught));
      setPending(null);
    }
  }

  const isDev = metadata.data?.env === "dev";

  return (
    <main className="app-backdrop grain relative grid min-h-dvh place-items-center px-4 py-10">
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="glass w-full max-w-sm rounded-2xl p-7"
        aria-labelledby="sign-in-title"
      >
        <Link to="/" className="inline-flex" aria-label="Tenderline home">
          <Logo />
        </Link>
        <h1 id="sign-in-title" className="mt-6 text-xl font-semibold tracking-[-0.01em]">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-muted">
          First time here? You will set up your company and see your first tenders in about a minute.
        </p>

        {isDev ? (
          <form onSubmit={withDevAccount} className="mt-6">
            <Field label="Local account name" hint="This is a development server: pick any name, no password. The same name brings you back to the same account.">
              {(props) => (
                <Input
                  {...props}
                  value={devLogin}
                  onChange={(event) => setDevLogin(event.target.value)}
                  placeholder="e.g. aoife"
                  autoComplete="username"
                  autoFocus
                  required
                  minLength={1}
                  maxLength={100}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" size="lg" className="mt-3 w-full justify-center" pending={pending === "dev"}>
              Sign in locally
            </Button>
            <p className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-hairline-strong" /> or <span className="h-px flex-1 bg-hairline-strong" />
            </p>
          </form>
        ) : (
          <p className="mt-4 text-sm text-muted">Use your GitHub account. Tenderline only reads your public profile.</p>
        )}

        <Button
          variant={isDev ? "secondary" : "primary"}
          size="lg"
          className={isDev ? "w-full justify-center" : "mt-4 w-full justify-center"}
          pending={pending === "github"}
          onClick={withGitHub}
        >
          {pending === "github" ? null : <GitHubMark />} Continue with GitHub
        </Button>

        {error ? (
          <p role="alert" className="mt-4 rounded-lg border border-lost/30 bg-lost-soft px-3 py-2 text-sm text-lost">
            {error}
          </p>
        ) : null}
      </motion.section>
    </main>
  );
}
