/**
 * Clerk session JWTs: v1 used `org_id` / `org_role`; v2 nests them on `o`.
 * app-api and realtime-worker already read `o.id`. Billing-worker must too,
 * or phone checkout sees a valid workspace JWT as "No organization selected".
 */

export interface ClerkJwtOrgClaims {
  org_id?: string;
  org_role?: string;
  o?: { id?: string; rol?: string };
}

export function orgIdFromClerkPayload(payload: ClerkJwtOrgClaims): string | null {
  const id = payload.o?.id || payload.org_id || null;
  const trimmed = id?.trim();
  return trimmed || null;
}

/** Normalize to Clerk v1 `org:admin` / `org:member` so `requireOrgAdmin` keeps working. */
export function orgRoleFromClerkPayload(payload: ClerkJwtOrgClaims): string | null {
  const raw = payload.o?.rol || payload.org_role || null;
  const role = raw?.trim();
  if (!role) return null;
  return role.startsWith('org:') ? role : `org:${role}`;
}
