import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { meetings, meetingSessions } from '@weldsuite/db/schema';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';

/**
 * Signed guest session tokens.
 *
 * The guest chat / upload / leave routes used to identify the caller by
 * (orgId, meetingId, email) alone. orgId and the join code are in the public
 * link and meetingId comes back from the public /api/meeting/info, so anyone
 * holding the link who knew a guest's email could read the chat, post and
 * upload as that guest, or mark them as left.
 *
 * /api/meeting/join now mints an HMAC token bound to the org, meeting, session,
 * guest identity and the RTK participant id it just created. The guest sends it
 * as `Authorization: Bearer <token>` and the routes trust only its claims.
 * Because the RTK participant id is part of the token, a later join under the
 * same email (which replaces the participant entry) invalidates older tokens.
 */

const TOKEN_VERSION = 1;
/** Long enough for any meeting; a rejoin mints a fresh token anyway. */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface GuestSessionClaims {
  /** Org / workspace id the tenant DB was resolved from. */
  org: string;
  meetingId: string;
  sessionId: string;
  /** `guest:<email>` as stored on the session participant. */
  guestUserId: string;
  /** RTK participant id returned by addParticipant at join time. */
  cfSessionId: string;
}

interface TokenPayload extends GuestSessionClaims {
  v: number;
  exp: number;
}

/**
 * Signing key, derived from the RealtimeKit app secret (which the portal
 * already needs to let a guest join at all) and domain-separated so the raw
 * secret is never used for anything else. Fails closed when it is unset.
 */
function getSigningKey(): Buffer {
  const rtkSecret = process.env.CF_REALTIME_APP_SECRET;
  if (!rtkSecret) {
    throw new Error('Guest session signing key unavailable: CF_REALTIME_APP_SECRET is not set');
  }
  return createHmac('sha256', rtkSecret).update('weldmeet-guest-session-token:v1').digest();
}

function sign(encodedPayload: string): Buffer {
  return createHmac('sha256', getSigningKey()).update(encodedPayload).digest();
}

export function createGuestSessionToken(claims: GuestSessionClaims, now = Date.now()): string {
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    ...claims,
    exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded).toString('base64url')}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Verify signature + expiry and return the claims, or null when invalid. */
export function verifyGuestSessionToken(token: string, now = Date.now()): GuestSessionClaims | null {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;

  const expected = sign(encoded);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: Partial<TokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TokenPayload>;
  } catch {
    return null;
  }

  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  if (
    !isNonEmptyString(payload.org) ||
    !isNonEmptyString(payload.meetingId) ||
    !isNonEmptyString(payload.sessionId) ||
    !isNonEmptyString(payload.guestUserId) ||
    !isNonEmptyString(payload.cfSessionId)
  ) {
    return null;
  }

  return {
    org: payload.org,
    meetingId: payload.meetingId,
    sessionId: payload.sessionId,
    guestUserId: payload.guestUserId,
    cfSessionId: payload.cfSessionId,
  };
}

/** Read the bearer token from the Authorization header. */
export function readGuestSessionToken(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return match?.[1] ?? null;
}

/**
 * Authenticate a guest request for a meeting: the token must be valid and
 * issued for this org + meeting. Returns the claims, or null.
 */
export function authenticateGuest(
  headers: Headers,
  orgId: string,
  meetingId: string,
): GuestSessionClaims | null {
  const token = readGuestSessionToken(headers);
  if (!token) return null;
  const claims = verifyGuestSessionToken(token);
  if (!claims || claims.org !== orgId || claims.meetingId !== meetingId) return null;
  return claims;
}

/** True when the stored participant is the one the token was issued for. */
export function isTokenParticipant(p: MeetingSessionParticipant, claims: GuestSessionClaims): boolean {
  return p.userId.toLowerCase() === claims.guestUserId.toLowerCase() && p.cfSessionId === claims.cfSessionId;
}

/** Email of the guest the token was issued for. */
export function guestEmailFromClaims(claims: GuestSessionClaims): string {
  return claims.guestUserId.replace(/^guest:/, '');
}

/**
 * Verify the token's guest is still an active participant of the meeting's
 * active session (same session, same RTK participant, not left). Returns the
 * stored participant (with userName + userAvatar) or null.
 *
 * Shared by the guest chat message + upload routes so a guest can only read,
 * post or upload in a meeting they are actually in.
 */
export async function verifyGuestParticipant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  claims: GuestSessionClaims,
): Promise<MeetingSessionParticipant | null> {
  const [meeting] = await db
    .select({ activeSessionId: meetings.activeSessionId })
    .from(meetings)
    .where(and(eq(meetings.id, claims.meetingId), isNull(meetings.deletedAt)))
    .limit(1);

  if (!meeting?.activeSessionId || meeting.activeSessionId !== claims.sessionId) return null;

  const [session] = await db
    .select({ participants: meetingSessions.participants, status: meetingSessions.status })
    .from(meetingSessions)
    .where(eq(meetingSessions.id, claims.sessionId))
    .limit(1);

  if (!session || session.status === 'ended') return null;

  const participants: MeetingSessionParticipant[] = session.participants ?? [];
  const match = participants.find((p) => isTokenParticipant(p, claims) && !p.leftAt);
  return match ?? null;
}
