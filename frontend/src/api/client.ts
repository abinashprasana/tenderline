import createClient from "openapi-fetch";

import { getToken, setSession } from "@/auth/session";

import { ApiError, NetworkError } from "./errors";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either a number of seconds or an HTTP date. */
export function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_WAIT_MS);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 1000 : Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_WAIT_MS);
}

type ExpiredHandler = () => void;
let onExpired: ExpiredHandler = () => {};

/** The router registers this so a 401 sends the person to sign-in, remembering where they were. */
export function setExpiredHandler(handler: ExpiredHandler): void {
  onExpired = handler;
}

/**
 * The fetch every API call goes through:
 * - adds the bearer token;
 * - on 429 waits for Retry-After and tries again, but only when a retry cannot do something twice (a read, or
 *   a write that carries an Idempotency-Key, which the server deduplicates);
 * - on 401 for a signed-in request, ends the session.
 */
export async function apiFetch(request: Request): Promise<Response> {
  const token = getToken();
  if (token && !request.headers.has("Authorization")) request.headers.set("Authorization", `Bearer ${token}`);
  const retryable = request.method === "GET" || request.headers.has("Idempotency-Key");

  let attempt = request;
  for (let tries = 0; ; tries += 1) {
    const spare = retryable ? attempt.clone() : null;
    let response: Response;
    try {
      response = await fetch(attempt);
    } catch (cause) {
      throw new NetworkError(cause);
    }
    if (response.status === 429 && spare && tries < MAX_RATE_LIMIT_RETRIES) {
      await sleep(retryAfterMs(response.headers.get("Retry-After")));
      attempt = spare;
      continue;
    }
    if (response.status === 401 && token && !new URL(request.url).pathname.startsWith("/v1/auth/")) {
      setSession(null);
      onExpired();
    }
    return response;
  }
}

export const api = createClient<paths>({ baseUrl: window.location.origin, fetch: apiFetch });

/** openapi-fetch result -> data, or throw the API's error. A 204 resolves to undefined. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw ApiError.fromResponse(response, error);
  return data as T;
}

/**
 * One key per user intent. Pass the same key when retrying the same submission (a double click, a retry
 * after a network error) so the server runs it once; make a new one for a new submission.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
