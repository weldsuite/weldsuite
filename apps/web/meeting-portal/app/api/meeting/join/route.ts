import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetings, meetingSessions } from '@weldsuite/db/schema';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { addParticipant, ensurePresets, RTK_PRESETS } from '@/lib/cloudflare-realtime';
import { findOrCreatePersonByEmail } from '@/lib/people';
import { createGuestSessionToken } from '@/lib/guest-session';
import { guestJoinInputSchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';

type TenantDb = Awaited<ReturnType<typeof getTenantDb>>['db'];
type Meeting = typeof meetings.$inferSelect;
type MeetingSession = typeof meetingSessions.$inferSelect;

function apiError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function waitingResponse(meeting: Meeting, reason?: string) {
  return NextResponse.json({
    data: {
      status: 'waiting' as const,
      ...(reason ? { reason } : {}),
      meetingId: meeting.id,
      meetingTitle: meeting.title,
    },
  });
}

function findAttendee(
  attendees: MeetingAttendee[] | null | undefined,
  email: string,
): MeetingAttendee | undefined {
  const wanted = email.toLowerCase();
  return (attendees ?? []).find((a) => a.email.toLowerCase() === wanted);
}

/**
 * True only for attendees the organizer invited. Walk-up guests are written
 * to the attendees list on their first join attempt (see addGuestAttendee),
 * so they must not count here, or a single join attempt would let them skip
 * the waiting room / "Lock after start" on every later attempt.
 */
function isInvitedAttendee(attendees: MeetingAttendee[] | null | undefined, email: string): boolean {
  const attendee = findAttendee(attendees, email);
  return !!attendee && attendee.source !== 'walk_in';
}

/**
 * Static access policy for a guest join: cancelled / completed meetings and
 * workspace-only or invite-only access. Returns the refusal response, or null
 * when the guest may continue.
 */
function checkMeetingAccess(meeting: Meeting, email: string): NextResponse | null {
  if (meeting.status === 'cancelled') {
    return apiError('BAD_REQUEST', 'Meeting is cancelled', 400);
  }

  // The host has closed the meeting (endSession sets status='completed' and
  // clears activeSessionId). Return a terminal 'ended' status rather than
  // falling through to the "no active session" → 'waiting' branch below,
  // which would leave a rejoining guest polling/"Connecting" forever with no
  // idea the meeting is over.
  if (meeting.status === 'completed') {
    return NextResponse.json({
      data: { status: 'ended' as const, meetingId: meeting.id, meetingTitle: meeting.title },
    });
  }

  if (meeting.accessType === 'workspace') {
    return apiError('FORBIDDEN', 'This meeting is restricted to workspace members', 403);
  }

  if (meeting.accessType === 'invited_only' && !isInvitedAttendee(meeting.attendees, email)) {
    return apiError('FORBIDDEN', 'You are not invited to this meeting', 403);
  }

  return null;
}

/**
 * Host-control policy: "Host must join first". Block guest joins until the
 * organizer is present in an active session.
 */
async function checkHostPresent(db: TenantDb, meeting: Meeting): Promise<NextResponse | null> {
  if (!meeting.hostMustJoinFirst) return null;

  const waiting = waitingResponse(meeting, 'host_must_join_first');
  if (!meeting.activeSessionId) return waiting;

  const [activeSession] = await db
    .select()
    .from(meetingSessions)
    .where(eq(meetingSessions.id, meeting.activeSessionId))
    .limit(1);
  const hostPresent = !!activeSession?.participants?.some?.(
    (p: { userId?: string }) => p.userId === meeting.organizerId,
  );
  return hostPresent ? null : waiting;
}

/**
 * Host-control policy: "Lock after start". Once an active session is running,
 * only previously-invited attendees may join. Walk-up guests are refused with
 * 403.
 */
async function checkLockAfterStart(
  db: TenantDb,
  meeting: Meeting,
  email: string,
): Promise<NextResponse | null> {
  if (!meeting.lockAfterStart) return null;

  const [activeSession] = meeting.activeSessionId
    ? await db.select().from(meetingSessions).where(eq(meetingSessions.id, meeting.activeSessionId)).limit(1)
    : [null];
  const sessionIsActive = !!activeSession && activeSession.status === 'active';
  if (sessionIsActive && !isInvitedAttendee(meeting.attendees, email)) {
    return apiError('FORBIDDEN', 'This meeting is locked. New participants are not allowed.', 403);
  }
  return null;
}

/**
 * Add the guest to the meeting attendees (for display and history) if not
 * already present, marked as a walk-in so it never counts as an invitation.
 */
async function addGuestAttendee(
  db: TenantDb,
  meeting: Meeting,
  email: string,
  name: string,
): Promise<void> {
  if (findAttendee(meeting.attendees, email)) return;

  const guest: MeetingAttendee = {
    userId: '',
    email,
    name,
    status: 'accepted',
    role: 'attendee',
    source: 'walk_in',
  };
  await db.update(meetings).set({
    attendees: [...(meeting.attendees ?? []), guest],
    updatedAt: new Date(),
  }).where(eq(meetings.id, meeting.id));
}

async function loadActiveSession(db: TenantDb, meeting: Meeting): Promise<MeetingSession | null> {
  if (!meeting.activeSessionId) return null;
  const [session] = await db
    .select()
    .from(meetingSessions)
    .where(eq(meetingSessions.id, meeting.activeSessionId))
    .limit(1);
  return session ?? null;
}

/** Record the guest in the session participants and activate a waiting session. */
async function saveSessionParticipant(
  db: TenantDb,
  session: MeetingSession,
  participant: MeetingSessionParticipant,
): Promise<void> {
  const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
  const filtered = participants.filter((p) => p.userId !== participant.userId);
  filtered.push(participant);

  const now = new Date();
  const updates: Record<string, unknown> = {
    participants: filtered,
    maxParticipants: Math.max(session.maxParticipants ?? 0, filtered.length),
    updatedAt: now,
  };

  if (session.status === 'waiting') {
    updates.status = 'active';
    updates.startedAt = now;
  }

  await db.update(meetingSessions).set(updates).where(eq(meetingSessions.id, session.id));
}

/**
 * POST /api/meeting/join
 * Guest joins a meeting session.
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('BAD_REQUEST', 'Invalid JSON body', 400);
  }

  const parsed = guestJoinInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, joinCode, name, email, colorSeed } = parsed.data;

  try {
    const { db, workspaceId } = await getTenantDb(orgId);

    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.joinCode, joinCode), isNull(meetings.deletedAt)))
      .limit(1);

    if (!meeting) return apiError('NOT_FOUND', 'Meeting not found', 404);

    const blocked =
      checkMeetingAccess(meeting, email) ??
      (await checkHostPresent(db, meeting)) ??
      (await checkLockAfterStart(db, meeting, email));
    if (blocked) return blocked;

    // Host-control policy: "Waiting room". When enabled, guests join RTK with
    // the GUEST_WAITING preset (waiting_room_type = SKIP_ON_ACCEPT), so the
    // RTK SDK drops them into the native waiting room. The platform host sees
    // them in `meeting.participants.waitlisted` (AdmitGuestsPill) and admits or
    // denies via acceptWaitingRoomRequest / rejectWaitingRoomRequest; the guest
    // portal reacts to the RTK `waitlisted` / `roomJoined` / `roomLeft(rejected)`
    // events. Pre-invited attendees are trusted on the attendees list already
    // and skip straight in with the standard GUEST preset; walk-up guests
    // recorded by an earlier join attempt do not, so a refresh or a guest the
    // host denied still lands back in the waiting room.
    const isPreInvited = isInvitedAttendee(meeting.attendees, email);
    const guestPreset =
      meeting.waitingRoom && !isPreInvited ? RTK_PRESETS.GUEST_WAITING : RTK_PRESETS.GUEST;

    await addGuestAttendee(db, meeting, email, name);

    // Check for active session
    const session = await loadActiveSession(db, meeting);
    if (!session || session.status === 'ended') return waitingResponse(meeting);

    if (!session.cfAppId) {
      return apiError('INTERNAL', 'Session has no RTK meeting ID', 500);
    }

    await ensurePresets();

    // Match the guest's email against the workspace's identity layer (people)
    // so we can surface the person's avatar to every other participant via RTK.
    // If no person exists, auto-create one — including generating an initials
    // SVG and uploading it to R2 at the same path the rest of the platform
    // uses (participant-resolver).
    const { id: personId, avatarUrl } = await findOrCreatePersonByEmail(db, {
      email,
      name,
      workspaceId,
    });
    const guestAvatarUrl = avatarUrl ?? undefined;

    const guestUserId = `guest:${email}`;
    // RTK customParticipantId is what every client reads from the participant
    // object — passing the guest's pre-join colorSeed here means the color
    // hashed by the portal's preview, the portal's own in-meeting self tile,
    // AND the platform host's view of the guest all derive from the same
    // string. Fall back to guestUserId for clients that predate the colorSeed
    // field. Note: the inbound RTK webhook now looks participants up by
    // `event.participant.id` → `cfSessionId`, so swapping the customParticipantId
    // value does not break participant-left tracking.
    const customParticipantId = typeof colorSeed === 'string' && colorSeed.length > 0
      ? colorSeed
      : guestUserId;
    const rtkParticipant = await addParticipant(session.cfAppId, {
      name,
      customParticipantId,
      presetName: guestPreset,
      picture: guestAvatarUrl,
    });

    await saveSessionParticipant(db, session, {
      userId: guestUserId,
      userName: name,
      userAvatar: guestAvatarUrl,
      joinedAt: new Date().toISOString(),
      cfSessionId: rtkParticipant.id,
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
      personId,
    });

    // Chat, upload and leave authenticate the guest with this token, bound
    // to the RTK participant created above, instead of trusting an email.
    const guestToken = createGuestSessionToken({
      org: orgId,
      meetingId: meeting.id,
      sessionId: session.id,
      guestUserId,
      cfSessionId: rtkParticipant.id,
    });

    return NextResponse.json({
      data: {
        status: 'joined' as const,
        sessionId: session.id,
        authToken: rtkParticipant.token,
        guestToken,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
      },
    });
  } catch (err) {
    console.error('[MeetingPortal] Failed to join meeting:', err);
    return apiError('INTERNAL', 'Failed to join meeting', 500);
  }
}
