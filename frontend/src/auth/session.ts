/**
 * The signed-in session: a short-lived bearer token kept in memory and in sessionStorage (so a reload keeps you
 * signed in, but closing the tab does not). The Content-Security-Policy served with the app forbids inline
 * and third-party scripts, which is what protects this token from injected code.
 */

export interface Session {
  token: string;
  userId: string;
  login: string;
  expiresAt: number; // epoch ms
}

const KEY = "tenderline.session";
type Listener = (session: Session | null) => void;

let current: Session | null = load();
const listeners = new Set<Listener>();

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads `exp` from a JWT without verifying it; the server verifies. */
export function tokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function getSession(): Session | null {
  if (current && current.expiresAt <= Date.now()) setSession(null);
  return current;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function setSession(next: Session | null): void {
  current = next;
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: memory only */
  }
  listeners.forEach((listener) => listener(next));
}

export function startSession(token: string, userId: string, login: string): Session {
  const session = { token, userId, login, expiresAt: tokenExpiry(token) };
  setSession(session);
  return session;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where to return after signing in again. Only same-app paths are accepted. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}
