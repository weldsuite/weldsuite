/**
 * Public share link of a WeldMeet meeting.
 *
 * Guests join through the public meeting portal (`apps/web/meeting-portal`,
 * route `/[orgId]/[joinCode]`), never through the platform, which requires a
 * login. The workspace id is part of the path because the portal uses it to
 * resolve the tenant database.
 */

/** Production meeting portal. Used when `VITE_MEETING_PORTAL_URL` is not set. */
export const DEFAULT_MEETING_PORTAL_URL = 'https://meet.weldsuite.org';

export function getMeetingPortalUrl(): string {
  const configured = (import.meta.env.VITE_MEETING_PORTAL_URL as string | undefined)?.trim();
  return (configured || DEFAULT_MEETING_PORTAL_URL).replace(/\/+$/, '');
}

/**
 * Returns the guest link, or `null` when it cannot be a working link (missing
 * join code or workspace id). Callers must not show or copy a link in that case.
 */
export function buildMeetingShareUrl(
  workspaceId: string | null | undefined,
  joinCode: string | null | undefined,
): string | null {
  const code = joinCode?.trim();
  if (!workspaceId || !code) return null;
  return `${getMeetingPortalUrl()}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(code)}`;
}
