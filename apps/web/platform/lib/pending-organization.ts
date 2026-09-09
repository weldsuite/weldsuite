/**
 * Remember which Clerk organization should be active after a full-page reload.
 *
 * Creating a workspace from the user menu calls Clerk `setActive` and then
 * hard-navigates to `/`. Clerk often comes back with either no active org or
 * the previous one — the session cookie races the navigation, and the new
 * membership is not yet in the client cache. The app shell used to "recover"
 * by activating memberships[0], which is the *old* workspace.
 *
 * Stashing the new org id here lets the shell activate the workspace the user
 * just created instead.
 */
const PENDING_ORG_KEY = 'weldsuite:pending-org';

export function setPendingOrganization(orgId: string): void {
  try {
    sessionStorage.setItem(PENDING_ORG_KEY, orgId);
  } catch {
    // sessionStorage unavailable (private mode / quota) — non-fatal.
  }
}

export function peekPendingOrganization(): string | null {
  try {
    return sessionStorage.getItem(PENDING_ORG_KEY);
  } catch {
    return null;
  }
}

export function clearPendingOrganization(): void {
  try {
    sessionStorage.removeItem(PENDING_ORG_KEY);
  } catch {
    // Ignore — best-effort cleanup.
  }
}

/**
 * Pick the Clerk org the app shell should activate.
 *
 * A pending org (just created / just requested) always wins over the current
 * session and over "first membership" fallback. Only when nothing is pending
 * and the session has no org do we fall back to the first membership.
 */
export function resolveOrganizationToActivate({
  orgId,
  pendingOrgId,
  firstOrgId,
}: {
  orgId: string | null | undefined;
  pendingOrgId: string | null | undefined;
  firstOrgId: string | null | undefined;
}): string | null {
  if (pendingOrgId && pendingOrgId !== orgId) return pendingOrgId;
  if (!orgId) return firstOrgId ?? null;
  return null;
}
