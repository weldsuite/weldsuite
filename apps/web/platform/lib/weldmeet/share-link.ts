import { publicEnv } from '@/lib/runtime-config';
/**
 * Public share link of a WeldMeet meeting.
 *
 * An install that runs a public meeting portal names it in `/config.json`
 * (`env.VITE_MEETING_PORTAL_URL`, the chart's `config.publicEnv`); the link is
 * then the portal's `/{workspace}/{code}`, which guests open without a login.
 * Without one the link is the platform's own join page
 * (`/w/{workspace}/weldmeet/join/{code}`): people join there after signing in.
 * The server's invitation emails build the same link
 * (`rust/modules/meet/src/invitations.rs`).
 */

/** The meeting portal's origin, or null when the install has none. */
export function getMeetingPortalUrl(): string | null {
  const configured = publicEnv('VITE_MEETING_PORTAL_URL')?.trim();
  return configured ? configured.replace(/(?<!\/)\/+$/, '') : null;
}

/** The platform's join page for the meeting, inside its workspace. */
function platformJoinUrl(workspaceId: string, code: string): string | null {
  if (typeof window === 'undefined') return null;
  return `${window.location.origin}/w/${encodeURIComponent(workspaceId)}/weldmeet/join/${encodeURIComponent(code)}`;
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
  const portal = getMeetingPortalUrl();
  if (!portal) return platformJoinUrl(workspaceId, code);
  return `${portal}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(code)}`;
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
