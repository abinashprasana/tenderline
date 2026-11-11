import { describe, expect, it, vi } from "vitest";

import { getSession, startSession } from "@/auth/session";

import { apiFetch, retryAfterMs, setExpiredHandler, unwrap } from "./client";
import { ApiError, describeError, fieldErrors, NetworkError } from "./errors";

/** A JWT-shaped token whose payload expires `seconds` from now. The signature is irrelevant to the client. */
function token(seconds = 3600): string {
  const payload = btoa(JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + seconds }));
  return `x.${payload.replace(/=+$/, "")}.y`;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("apiFetch", () => {
  it("sends the bearer token", async () => {
    startSession(token(), "u1", "aoife");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, {}));
    await apiFetch(new Request("http://test/v1/me"));
    const sent = fetchMock.mock.calls[0]![0] as Request;
    expect(sent.headers.get("Authorization")).toMatch(/^Bearer x\./);
  });

  it("waits for Retry-After and retries a read once rate limited", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(429, { error: { code: "rate_limited" } }, { "Retry-After": "2" }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pending = apiFetch(new Request("http://test/v1/notices"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a write only when it carries an Idempotency-Key, with the same key and body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(429, {}, { "Retry-After": "0" }))
      .mockResolvedValueOnce(json(200, {}));
    const request = new Request("http://test/v1/organisations/o/agent-proposals/p/approve", {
      method: "POST",
      headers: { "Idempotency-Key": "k-1" },
      body: JSON.stringify({ comment: null }),
    });
    const pending = apiFetch(request);
    await vi.runAllTimersAsync();
    await pending;
    const retried = fetchMock.mock.calls[1]![0] as Request;
    expect(retried.headers.get("Idempotency-Key")).toBe("k-1");
    expect(await retried.text()).toBe('{"comment":null}');
  });

  it("does not retry a write without an Idempotency-Key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(429, {}, { "Retry-After": "0" }));
    const response = await apiFetch(new Request("http://test/v1/x", { method: "PATCH", body: "{}" }));
    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends the session on 401 and calls the expiry handler, but not for auth endpoints", async () => {
    const expired = vi.fn();
    setExpiredHandler(expired);
    startSession(token(), "u1", "aoife");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(401, { error: { code: "invalid_token" } }));
    await apiFetch(new Request("http://test/v1/me"));
    expect(getSession()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);

    startSession(token(), "u1", "aoife");
    await apiFetch(new Request("http://test/v1/auth/refresh", { method: "POST" }));
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("wraps network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(apiFetch(new Request("http://test/v1/me"))).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("unwrap", () => {
  it("resolves a 204 to undefined without parsing a body", async () => {
    const result = await unwrap(Promise.resolve({ data: undefined, response: new Response(null, { status: 204 }) }));
    expect(result).toBeUndefined();
  });

  it("throws the API error model", async () => {
    const response = new Response(null, { status: 409 });
    const error = { error: { code: "already_decided", message: "Already decided", request_id: "r1" } };
    await expect(unwrap(Promise.resolve({ error, response }))).rejects.toMatchObject({
      status: 409,
      code: "already_decided",
      requestId: "r1",
    });
  });
});

describe("errors", () => {
  it("has plain text for documented codes and falls back to the server message", () => {
    expect(describeError(new ApiError(409, { code: "last_owner", message: "x" }))).toMatch(/at least one owner/);
    expect(describeError(new ApiError(400, { code: "something_new", message: "Server says so" }))).toBe("Server says so");
  });

  it("maps 422 validation details to fields", () => {
    const error = new ApiError(422, {
      code: "validation_error",
      details: [{ loc: ["body", "name"], msg: "Value error, too short" }],
    });
    expect(fieldErrors(error)).toEqual({ name: "too short" });
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, and caps the wait", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("600")).toBe(10_000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs(new Date(Date.now() + 2000).toUTCString())).toBeLessThanOrEqual(2000);
  });
});
