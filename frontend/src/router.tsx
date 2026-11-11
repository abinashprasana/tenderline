import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { api, unwrap } from "@/api/client";
import { keys } from "@/api/hooks";
import { getSession } from "@/auth/session";
import { RootLayout } from "@/app/root-layout";
import { NotFound, RouteError } from "@/app/route-states";

/** Uses the cached list unless it is older than 30 s or was invalidated (for example after creating an org). */
function loadOrgs(queryClient: QueryClient) {
  return queryClient.fetchQuery({
    queryKey: keys.orgs,
    queryFn: () => unwrap(api.GET("/v1/organisations")),
    staleTime: 30_000,
  });
}

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

function requireSession({ location }: { location: { href: string } }) {
  if (!getSession()) throw redirect({ to: "/sign-in", search: { next: location.href } });
}

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("@/screens/landing/landing"), "Landing"),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: lazyRouteComponent(() => import("@/screens/auth/sign-in"), "SignIn"),
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: lazyRouteComponent(() => import("@/screens/auth/callback"), "AuthCallback"),
});

/** /app picks an organisation: the last one used, else the first, else the create-organisation screen. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  beforeLoad: async ({ context, location }) => {
    requireSession({ location });
    const orgs = await loadOrgs(context.queryClient);
    if (orgs.length === 0) throw redirect({ to: "/welcome" });
    const last = readLastOrg();
    const chosen = orgs.find((org) => org.id === last) ?? orgs[0];
    throw redirect({ to: "/o/$orgId", params: { orgId: chosen!.id } });
  },
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  beforeLoad: requireSession,
  component: lazyRouteComponent(() => import("@/screens/welcome"), "Welcome"),
});

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/o/$orgId",
  beforeLoad: async ({ context, location, params }) => {
    requireSession({ location });
    const orgs = await loadOrgs(context.queryClient);
    const org = orgs.find((candidate) => candidate.id === params.orgId);
    if (!org) throw redirect({ to: "/app" });
    rememberOrg(org.id);
    return { org };
  },
  component: lazyRouteComponent(() => import("@/app/shell"), "Shell"),
});

const overviewRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/",
  component: lazyRouteComponent(() => import("@/screens/overview/overview"), "Overview"),
});

export const approvalsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/approvals",
  validateSearch: (search: Record<string, unknown>): { notice?: string; view?: "pending" | "decided" } => ({
    notice: typeof search.notice === "string" ? search.notice : undefined,
    view: search.view === "decided" ? "decided" : undefined,
  }),
  component: lazyRouteComponent(() => import("@/screens/approvals/approvals"), "Approvals"),
});

const opportunitiesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/opportunities",
  component: lazyRouteComponent(() => import("@/screens/opportunities/board"), "OpportunityBoard"),
});

export const opportunityRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/opportunities/$oppId",
  component: lazyRouteComponent(() => import("@/screens/opportunities/detail"), "OpportunityDetail"),
});

export interface NoticeSearch {
  q?: string;
  cpv?: string;
  buyer?: string;
  country?: string;
  status?: string;
  min_value?: number;
  max_value?: number;
  published_from?: string;
  deadline_after?: string;
  sort?: "created" | "published" | "deadline";
  notice?: string;
}

// The router parses search params as JSON, so "72000000" arrives as a number; codes and words stay strings here.
const str = (value: unknown) =>
  typeof value === "number" ? String(value) : typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const noticesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/notices",
  validateSearch: (search: Record<string, unknown>): NoticeSearch => ({
    q: str(search.q),
    cpv: str(search.cpv),
    buyer: str(search.buyer),
    country: str(search.country),
    status: str(search.status),
    min_value: num(search.min_value),
    max_value: num(search.max_value),
    published_from: str(search.published_from),
    deadline_after: str(search.deadline_after),
    sort: search.sort === "published" || search.sort === "deadline" ? search.sort : undefined,
    notice: str(search.notice),
  }),
  component: lazyRouteComponent(() => import("@/screens/notices/explorer"), "NoticeExplorer"),
});

export const matchesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/matches",
  validateSearch: (search: Record<string, unknown>): { search?: string } => ({ search: str(search.search) }),
  component: lazyRouteComponent(() => import("@/screens/matches"), "Matches"),
});

const deadlinesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/deadlines",
  component: lazyRouteComponent(() => import("@/screens/deadlines"), "Deadlines"),
});
const searchesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/searches",
  component: lazyRouteComponent(() => import("@/screens/searches"), "SavedSearches"),
});

export const auditRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/audit",
  validateSearch: (search: Record<string, unknown>): { actor?: "human" | "agent"; entity?: string; id?: string } => ({
    actor: search.actor === "human" || search.actor === "agent" ? search.actor : undefined,
    entity: str(search.entity),
    id: str(search.id),
  }),
  component: lazyRouteComponent(() => import("@/screens/audit"), "AuditLog"),
});

const ingestionRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/ingestion",
  component: lazyRouteComponent(() => import("@/screens/ingestion"), "Ingestion"),
});
const settingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("@/screens/settings"), "Settings"),
});

const routeTree = rootRoute.addChildren([
  landingRoute,
  signInRoute,
  callbackRoute,
  appRoute,
  welcomeRoute,
  orgRoute.addChildren([
    overviewRoute,
    approvalsRoute,
    opportunitiesRoute,
    opportunityRoute,
    noticesRoute,
    matchesRoute,
    deadlinesRoute,
    searchesRoute,
    auditRoute,
    ingestionRoute,
    settingsRoute,
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}

const LAST_ORG = "tenderline.org";
function readLastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
}
function rememberOrg(id: string) {
  try {
    localStorage.setItem(LAST_ORG, id);
  } catch {
    /* storage blocked */
  }
}
