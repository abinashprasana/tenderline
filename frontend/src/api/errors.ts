/** Every non-2xx response from the API has the shape {"error": {code, message, details, request_id}}. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  request_id?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(status: number, body: Partial<ApiErrorBody> | undefined) {
    super(body?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code ?? (status >= 500 ? "server_error" : "request_failed");
    this.details = body?.details;
    this.requestId = body?.request_id ?? null;
  }

  static fromResponse(response: Response, payload: unknown): ApiError {
    const body =
      payload && typeof payload === "object" && "error" in payload
        ? ((payload as { error: Partial<ApiErrorBody> }).error ?? undefined)
        : undefined;
    return new ApiError(response.status, body);
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not reach Tenderline. Check your connection and try again.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** Plain-English text for the error codes the API documents. Anything unknown falls back to the server's message. */
const MESSAGES: Record<string, string> = {
  already_decided: "Someone has already decided this proposal. The list has been refreshed.",
  proposal_stale: "The notice changed after this proposal was made. The agent is re-assessing it.",
  proposal_cancelled: "This proposal was withdrawn because the notice changed.",
  invalid_transition: "That status change is not allowed from the current status.",
  request_in_progress: "The same request is still being processed. Wait a moment, then refresh.",
  no_submission_deadline: "This opportunity has no submission deadline to count back from.",
  deadline_from_notice: "The notice's own deadline cannot be deleted.",
  deadline_in_past: "Pick a time in the future.",
  already_member: "That person is already a member.",
  last_owner: "An organisation must keep at least one owner.",
  idempotency_key_reuse: "This request was already sent with different details. Start again.",
  invalid_payload: "Some of the edited values are not valid for this action.",
  validation_error: "Some fields need attention.",
  rate_limited: "Too many requests. Slow down for a moment.",
  invalid_token: "Your session has ended. Sign in again.",
  session_expired: "Your session has ended. Sign in again.",
  unauthorized: "Sign in to continue.",
  forbidden: "Your role does not allow this action.",
  not_found: "That item no longer exists, or you do not have access to it.",
  invalid_cursor: "The list moved on. Reload to see the latest.",
  invalid_state: "The sign-in link expired or came from another browser. Start sign-in again.",
  oauth_exchange_failed: "GitHub did not accept the sign-in. Start again.",
  github_unreachable: "GitHub could not be reached. Try again shortly.",
  github_profile_unavailable: "GitHub did not return your profile. Try again shortly.",
  github_oauth_not_configured: "GitHub sign-in is not configured on this server.",
  workflows_unavailable: "Background processing is restarting. Try again in a minute.",
  invalid_role: "That role does not exist.",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? error.message;
  if (error instanceof NetworkError) return error.message;
  return "Something went wrong. Try again.";
}

/** Field-level messages from a 422 validation error, keyed by the last part of each location. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const item of error.details as { loc?: unknown[]; msg?: string }[]) {
    const key = item.loc?.at(-1);
    if (typeof key === "string" && item.msg) out[key] = item.msg.replace(/^Value error, /, "");
  }
  return out;
}
