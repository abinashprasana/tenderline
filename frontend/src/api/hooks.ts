import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useRef } from "react";

import { api, newIdempotencyKey, unwrap, type Schemas } from "./client";

export type Proposal = Schemas["ProposalOut"];
export type Opportunity = Schemas["OpportunityOut"];
export type Notice = Schemas["NoticeOut"];
export type Deadline = Schemas["DeadlineOut"];
export type Match = Schemas["MatchOut"];
export type SavedSearch = Schemas["SearchOut"];
export type AuditEntry = Schemas["AuditOut"];
export type Run = Schemas["RunOut"];
export type Summary = Schemas["SummaryOut"];
export type MyOrg = Schemas["MyOrgOut"];
export type Member = Schemas["MemberOut"];
export type Org = Schemas["OrgOut"];
export type Cpv = Schemas["CpvOut"];

export const keys = {
  me: ["me"] as const,
  orgs: ["orgs"] as const,
  metadata: ["metadata"] as const,
  org: (org: string) => ["org", org] as const,
  summary: (org: string) => ["org", org, "summary"] as const,
  proposals: (org: string, params?: object) => ["org", org, "proposals", params ?? {}] as const,
  proposal: (org: string, id: string) => ["org", org, "proposal", id] as const,
  opportunities: (org: string, params?: object) => ["org", org, "opportunities", params ?? {}] as const,
  opportunity: (org: string, id: string) => ["org", org, "opportunity", id] as const,
  deadlines: (org: string, params?: object) => ["org", org, "deadlines", params ?? {}] as const,
  matches: (org: string, params?: object) => ["org", org, "matches", params ?? {}] as const,
  searches: (org: string) => ["org", org, "searches"] as const,
  audit: (org: string, params?: object) => ["org", org, "audit", params ?? {}] as const,
  members: (org: string) => ["org", org, "members"] as const,
  notices: (params: object) => ["notices", params] as const,
  notice: (id: string) => ["notice", id] as const,
  versions: (id: string) => ["notice", id, "versions"] as const,
  runs: ["runs"] as const,
  cpv: (q: string, divisionsOnly: boolean) => ["cpv", q, divisionsOnly] as const,
};

/* ------------------------------------------------------------------ account and organisations */
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => unwrap(api.GET("/v1/me")) });

export const useMyOrgs = () =>
  useQuery({ queryKey: keys.orgs, queryFn: () => unwrap(api.GET("/v1/organisations")), staleTime: 60_000 });

export const useMetadata = () =>
  useQuery({ queryKey: keys.metadata, queryFn: () => unwrap(api.GET("/v1/metadata")), staleTime: Infinity });

export const useOrgDetails = (org: string) =>
  useQuery({
    queryKey: keys.org(org),
    queryFn: () => unwrap(api.GET("/v1/organisations/{org_id}", { params: { path: { org_id: org } } })),
  });

export const useSummary = (org: string) =>
  useQuery({
    queryKey: keys.summary(org),
    queryFn: () => unwrap(api.GET("/v1/organisations/{org_id}/summary", { params: { path: { org_id: org } } })),
    refetchInterval: 60_000,
  });

export const useMembers = (org: string) =>
  useQuery({
    queryKey: keys.members(org),
    queryFn: () => unwrap(api.GET("/v1/organisations/{org_id}/members", { params: { path: { org_id: org } } })),
  });

/* ------------------------------------------------------------------ proposals */
export type ProposalStatus = "pending" | "approved" | "rejected" | "cancelled" | "executed" | "failed";

export const useProposals = (org: string, params: { status?: ProposalStatus; notice_id?: string; limit?: number }) =>
  useQuery({
    queryKey: keys.proposals(org, params),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/agent-proposals", {
          params: { path: { org_id: org }, query: { limit: 200, ...params } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** Polls while the proposal is approved but not yet executed or failed. */
export const useProposal = (org: string, id: string | undefined) =>
  useQuery({
    queryKey: keys.proposal(org, id ?? ""),
    enabled: Boolean(id),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/agent-proposals/{proposal_id}", {
          params: { path: { org_id: org, proposal_id: id ?? "" } },
        }),
      ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "executed" || status === "failed" || status === "rejected" ? false : 1200;
    },
  });

/**
 * A mutation that sends an Idempotency-Key. The key stays the same while the person retries the same
 * submission and is replaced once it succeeds, so a double click or a retry after a dropped connection
 * runs the action once.
 */
function useIdempotent<TVars, TData>(
  run: (vars: TVars, key: string) => Promise<TData>,
  invalidate: (vars: TVars) => QueryKey[],
) {
  const queryClient = useQueryClient();
  const key = useRef<string | null>(null);
  return useMutation({
    mutationFn: (vars: TVars) => {
      key.current ??= newIdempotencyKey();
      return run(vars, key.current);
    },
    onSuccess: () => {
      key.current = null;
    },
    onSettled: (_data, _error, vars) =>
      Promise.all(invalidate(vars).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}

const proposalPath = (org: string, id: string) => ({ path: { org_id: org, proposal_id: id } });

export const useApprove = (org: string) =>
  useIdempotent(
    ({ id, comment }: { id: string; comment?: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/agent-proposals/{proposal_id}/approve", {
          params: { ...proposalPath(org, id), header: { "Idempotency-Key": key } },
          body: { comment: comment || null },
        }),
      ),
    () => [["org", org]],
  );

export const useEditApprove = (org: string) =>
  useIdempotent(
    ({ id, payload, comment }: { id: string; payload: Record<string, unknown>; comment?: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/agent-proposals/{proposal_id}/edit-approve", {
          params: { ...proposalPath(org, id), header: { "Idempotency-Key": key } },
          body: { payload, comment: comment || null },
        }),
      ),
    () => [["org", org]],
  );

export const useReject = (org: string) =>
  useIdempotent(
    ({ id, reason }: { id: string; reason: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/agent-proposals/{proposal_id}/reject", {
          params: { ...proposalPath(org, id), header: { "Idempotency-Key": key } },
          body: { reason },
        }),
      ),
    () => [["org", org]],
  );

/* ------------------------------------------------------------------ opportunities and deadlines */
export const useOpportunities = (org: string) =>
  useQuery({
    queryKey: keys.opportunities(org),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/opportunities", {
          params: { path: { org_id: org }, query: { limit: 200 } },
        }),
      ),
  });

export const useOpportunity = (org: string, id: string) =>
  useQuery({
    queryKey: keys.opportunity(org, id),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/opportunities/{opp_id}", {
          params: { path: { org_id: org, opp_id: id } },
        }),
      ),
  });

export function useSetStatus(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) =>
      unwrap(
        api.PATCH("/v1/organisations/{org_id}/opportunities/{opp_id}/status", {
          params: { path: { org_id: org, opp_id: id } },
          body: { status, reason: reason || null },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["org", org] }),
  });
}

export const useTrackNotice = (org: string) =>
  useIdempotent(
    ({ noticeId }: { noticeId: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/opportunities", {
          params: { path: { org_id: org }, header: { "Idempotency-Key": key } },
          body: { notice_id: noticeId },
        }),
      ),
    () => [["org", org]],
  );

export const useDeadlines = (org: string, withinDays: number) =>
  useQuery({
    queryKey: keys.deadlines(org, { withinDays }),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/deadlines", {
          params: { path: { org_id: org }, query: { within_days: withinDays } },
        }),
      ),
  });

export const useAddDeadline = (org: string) =>
  useIdempotent(
    ({ oppId, dueAt, note, kind }: { oppId: string; dueAt: string; note?: string; kind: "custom" | "clarification" }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/opportunities/{opp_id}/deadlines", {
          params: { path: { org_id: org, opp_id: oppId }, header: { "Idempotency-Key": key } },
          body: { due_at: dueAt, note: note || null, kind },
        }),
      ),
    () => [["org", org]],
  );

export const useAddReminders = (org: string) =>
  useIdempotent(
    ({ oppId, daysBefore }: { oppId: string; daysBefore: number[] }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/opportunities/{opp_id}/reminders", {
          params: { path: { org_id: org, opp_id: oppId }, header: { "Idempotency-Key": key } },
          body: { days_before: daysBefore },
        }),
      ),
    () => [["org", org]],
  );

export function useDeleteDeadline(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/v1/organisations/{org_id}/deadlines/{deadline_id}", {
          params: { path: { org_id: org, deadline_id: id } },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["org", org] }),
  });
}

/* ------------------------------------------------------------------ notices */
export interface NoticeQuery {
  q?: string;
  cpv?: string;
  buyer?: string;
  country?: string;
  status?: string;
  min_value?: number;
  max_value?: number;
  published_from?: string;
  published_to?: string;
  deadline_after?: string;
  sort?: "created" | "published" | "deadline";
}

export const useNotices = (params: NoticeQuery) =>
  useInfiniteQuery({
    queryKey: keys.notices(params),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/notices", {
          params: { query: { ...cleanParams(params), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const useNotice = (id: string | undefined) =>
  useQuery({
    queryKey: keys.notice(id ?? ""),
    enabled: Boolean(id),
    queryFn: () => unwrap(api.GET("/v1/notices/{notice_id}", { params: { path: { notice_id: id ?? "" } } })),
  });

export const useNoticeVersions = (id: string | undefined) =>
  useQuery({
    queryKey: keys.versions(id ?? ""),
    enabled: Boolean(id),
    queryFn: () =>
      unwrap(api.GET("/v1/notices/{notice_id}/versions", { params: { path: { notice_id: id ?? "" } } })),
  });

export const useCpvSearch = (q: string, divisionsOnly = false) =>
  useQuery({
    queryKey: keys.cpv(q, divisionsOnly),
    queryFn: () =>
      unwrap(api.GET("/v1/cpv-codes", { params: { query: { q, divisions_only: divisionsOnly, limit: 30 } } })),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

export const useRuns = () =>
  useQuery({
    queryKey: keys.runs,
    queryFn: () => unwrap(api.GET("/v1/ingestion-runs", { params: { query: { limit: 100 } } })),
    refetchInterval: 60_000,
  });

/* ------------------------------------------------------------------ matches and saved searches */
export const useMatches = (org: string, params: { saved_search_id?: string }) =>
  useQuery({
    queryKey: keys.matches(org, params),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/matches", {
          params: { path: { org_id: org }, query: { limit: 200, ...cleanParams(params) } },
        }),
      ),
  });

export const useQualify = (org: string) =>
  useIdempotent(
    ({ matchId }: { matchId: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/matches/{match_id}/qualify", {
          params: { path: { org_id: org, match_id: matchId }, header: { "Idempotency-Key": key } },
        }),
      ),
    () => [["org", org]],
  );

export const useSearches = (org: string) =>
  useQuery({
    queryKey: keys.searches(org),
    queryFn: () =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/saved-searches", {
          params: { path: { org_id: org }, query: { limit: 200 } },
        }),
      ),
  });

export type SearchInput = Schemas["SearchIn"];

export const useCreateSearch = (org: string) =>
  useIdempotent(
    (body: SearchInput, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/saved-searches", {
          params: { path: { org_id: org }, header: { "Idempotency-Key": key } },
          body,
        }),
      ),
    () => [["org", org]],
  );

export function useReplaceSearch(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SearchInput }) =>
      unwrap(
        api.PUT("/v1/organisations/{org_id}/saved-searches/{search_id}", {
          params: { path: { org_id: org, search_id: id } },
          body,
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["org", org] }),
  });
}

export function usePatchSearch(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active, name }: { id: string; active?: boolean; name?: string }) =>
      unwrap(
        api.PATCH("/v1/organisations/{org_id}/saved-searches/{search_id}", {
          params: { path: { org_id: org, search_id: id } },
          body: { active: active ?? null, name: name ?? null },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["org", org] }),
  });
}

export function useDeleteSearch(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/v1/organisations/{org_id}/saved-searches/{search_id}", {
          params: { path: { org_id: org, search_id: id } },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["org", org] }),
  });
}

/* ------------------------------------------------------------------ audit log */
export interface AuditQuery {
  entity_type?: string;
  entity_id?: string;
  actor_type?: string;
  action?: string;
}

export const useAudit = (org: string, params: AuditQuery, limit = 50) =>
  useInfiniteQuery({
    queryKey: keys.audit(org, { ...params, limit }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/organisations/{org_id}/audit-log", {
          params: {
            path: { org_id: org },
            query: { ...cleanParams(params), limit, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

/* ------------------------------------------------------------------ settings */
export type OrgProfile = Schemas["OrgProfile"];

export function usePatchOrg(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["OrgPatch"]) =>
      unwrap(api.PATCH("/v1/organisations/{org_id}", { params: { path: { org_id: org } }, body })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", org] }),
        queryClient.invalidateQueries({ queryKey: keys.orgs }),
      ]),
  });
}

export const useCreateOrg = () => {
  const queryClient = useQueryClient();
  const key = useRef<string | null>(null);
  return useMutation({
    mutationFn: (body: Schemas["OrgCreate"]) => {
      key.current ??= newIdempotencyKey();
      return unwrap(api.POST("/v1/organisations", { params: { header: { "Idempotency-Key": key.current } }, body }));
    },
    onSuccess: () => {
      key.current = null;
      return queryClient.invalidateQueries({ queryKey: keys.orgs });
    },
  });
};

export const useAddMember = (org: string) =>
  useIdempotent(
    ({ login, role }: { login: string; role: string }, key) =>
      unwrap(
        api.POST("/v1/organisations/{org_id}/members", {
          params: { path: { org_id: org }, header: { "Idempotency-Key": key } },
          body: { login, role },
        }),
      ),
    () => [keys.members(org)],
  );

export function useChangeRole(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      unwrap(
        api.PATCH("/v1/organisations/{org_id}/members/{user_id}", {
          params: { path: { org_id: org, user_id: userId } },
          body: { role },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.members(org) }),
  });
}

export function useRemoveMember(org: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE("/v1/organisations/{org_id}/members/{user_id}", {
          params: { path: { org_id: org, user_id: userId } },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.members(org) }),
  });
}

/** Drop empty strings and undefined so they are not sent as query parameters. */
export function cleanParams<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as Partial<T>;
}
