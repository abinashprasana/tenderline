/**
 * Mirrors the role tuples in the API (src/tenderline/api/deps.py). The UI uses these only to hide or disable
 * controls; the server checks every request regardless.
 */
export type Role = "viewer" | "reviewer" | "bid_manager" | "owner";
export type Capability = "read" | "decide" | "write" | "admin";

const ALLOWED: Record<Capability, readonly Role[]> = {
  read: ["viewer", "reviewer", "bid_manager", "owner"],
  decide: ["reviewer", "bid_manager", "owner"],
  write: ["bid_manager", "owner"],
  admin: ["owner"],
};

export const ROLES: readonly Role[] = ALLOWED.read;

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "Viewer",
  reviewer: "Reviewer",
  bid_manager: "Bid manager",
  owner: "Owner",
};

export function can(role: string | undefined, capability: Capability): boolean {
  return role !== undefined && (ALLOWED[capability] as readonly string[]).includes(role);
}

export const NEED: Record<Capability, string> = {
  read: "",
  decide: "Reviewers, bid managers and owners can decide proposals.",
  write: "Bid managers and owners can change this.",
  admin: "Only owners can change this.",
};
