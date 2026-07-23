/**
 * Clerk seat-limit helper for workspace-worker.
 *
 * Only needs syncClerkSeatLimit — used during onboarding to set
 * the free plan's max_allowed_memberships on the new organization.
 */

/**
 * PATCHes the Clerk organization's `max_allowed_memberships`.
 * Fire-and-forget — errors are logged, never thrown.
 *
 * When `effectiveLimit` is 0 we send `null` to Clerk, which removes the cap.
 */
export async function syncClerkSeatLimit(
  clerkSecretKey: string,
  clerkOrgId: string,
  effectiveLimit: number,
): Promise<void> {
  try {
    const body = JSON.stringify({
      max_allowed_memberships: effectiveLimit > 0 ? effectiveLimit : null,
    });

    const res = await fetch(
      `https://api.clerk.com/v1/organizations/${clerkOrgId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[Clerk Sync] Failed to update max_allowed_memberships for ${clerkOrgId}: ${res.status} ${text}`,
      );
    } else {
      console.log(
        `[Clerk Sync] Set max_allowed_memberships=${effectiveLimit || 'null'} for org ${clerkOrgId}`,
      );
    }
  } catch (err) {
    console.error('[Clerk Sync] Error syncing seat limit to Clerk:', err);
  }
}
