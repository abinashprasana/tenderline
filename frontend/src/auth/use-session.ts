import { useEffect, useSyncExternalStore } from "react";

import { api, unwrap } from "@/api/client";

import { getSession, setSession, startSession, subscribe, type Session } from "./session";

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}

const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * Renews the token five minutes before it expires, so a working session does not hit the 60-minute wall.
 * The server caps renewal at 12 hours after sign-in; after that the person signs in again.
 */
export function useSessionKeeper(onEnded: () => void): void {
  const session = useSession();
  useEffect(() => {
    if (!session) return;
    const wait = Math.max(session.expiresAt - Date.now() - REFRESH_BEFORE_MS, 5_000);
    const timer = window.setTimeout(async () => {
      try {
        const fresh = await unwrap(api.POST("/v1/auth/refresh"));
        startSession(fresh.access_token, fresh.user_id, fresh.login);
      } catch {
        setSession(null);
        onEnded();
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [session, onEnded]);
}
