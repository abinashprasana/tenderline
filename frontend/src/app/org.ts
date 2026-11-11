import { useRouteContext } from "@tanstack/react-router";

import type { MyOrg } from "@/api/hooks";
import { can, type Capability } from "@/lib/permissions";

/** The organisation the current page belongs to, with the signed-in person's role in it. */
export function useOrg(): MyOrg {
  return useRouteContext({ from: "/o/$orgId", select: (context) => context.org });
}

export function useCan(capability: Capability): boolean {
  return can(useOrg().role, capability);
}
