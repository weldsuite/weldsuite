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

export interface ParsedMeetingJoinInput {
  joinCode: string;
  /** Workspace id from a meeting-portal link (`/<orgId>/<joinCode>`), if any. */
  workspaceId: string | null;
  /** The input as a full URL, when it was a link. */
  url: string | null;
}

const SCHEME_RE = /^[a-z][a-z\d+.-]*:\/\//i;

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reads what a user typed or pasted into "Enter a code or link": a bare join
 * code, a meeting-portal link (`meet.weldsuite.org/<orgId>/<joinCode>`) or a
 * platform link (`/weldmeet/join/<joinCode>`), with or without a scheme.
 * Returns `null` when there is no join code in it.
 */
export function parseMeetingJoinInput(input: string): ParsedMeetingJoinInput | null {
  const value = input.trim();
  if (!value) return null;

  const looksLikeUrl = SCHEME_RE.test(value) || value.includes('/');
  if (!looksLikeUrl) return { joinCode: value, workspaceId: null, url: null };

  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(value) ? value : `https://${value}`);
  } catch {
    return { joinCode: value, workspaceId: null, url: null };
  }

  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
  const joinCode = segments.at(-1)?.trim();
  if (!joinCode) return null;

  const isPlatformJoin = segments.length === 3 && segments[0] === 'weldmeet' && segments[1] === 'join';
  const workspaceId = !isPlatformJoin && segments.length === 2 ? segments[0] : null;

  return { joinCode, workspaceId, url: url.toString() };
}
