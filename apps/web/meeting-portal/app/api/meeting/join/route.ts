import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetings, meetingSessions } from '@weldsuite/db/schema';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { addParticipant, ensurePresets, RTK_PRESETS } from '@/lib/cloudflare-realtime';
import { findOrCreatePersonByEmail } from '@/lib/people';
import { guestJoinInputSchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';

/**
 * POST /api/meeting/join
 * Guest joins a meeting session.
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
      { status: 400 },
    );
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

    if (!meeting) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Meeting not found' } },
        { status: 404 },
      );
    }

    if (meeting.status === 'cancelled') {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Meeting is cancelled' } },
        { status: 400 },
      );
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
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'This meeting is restricted to workspace members' } },
        { status: 403 },
      );
    }

    if (meeting.accessType === 'invited_only') {
      const attendees: MeetingAttendee[] = meeting.attendees ?? [];
      const isInvited = attendees.some(
        (a) => a.email.toLowerCase() === email.toLowerCase(),
      );
      if (!isInvited) {
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: 'You are not invited to this meeting' } },
          { status: 403 },
        );
      }
    }

    // Host-control policy: "Host must join first". Block guest joins until
    // the organizer is present in an active session.
    if (meeting.hostMustJoinFirst) {
      if (!meeting.activeSessionId) {
        return NextResponse.json({
          data: { status: 'waiting' as const, reason: 'host_must_join_first', meetingId: meeting.id, meetingTitle: meeting.title },
        });
      }
      const [activeSession] = await db
        .select()
        .from(meetingSessions)
        .where(eq(meetingSessions.id, meeting.activeSessionId))
        .limit(1);
      const hostPresent = !!activeSession?.participants?.some?.(
        (p: any) => p.userId === meeting.organizerId,
      );
      if (!hostPresent) {
        return NextResponse.json({
          data: { status: 'waiting' as const, reason: 'host_must_join_first', meetingId: meeting.id, meetingTitle: meeting.title },
        });
      }
    }

    // Host-control policy: "Lock after start". Once an active session is
    // running, only previously-invited attendees may join. Walk-up guests
    // are refused with 403.
    if (meeting.lockAfterStart) {
      const [activeSession] = meeting.activeSessionId
        ? await db.select().from(meetingSessions).where(eq(meetingSessions.id, meeting.activeSessionId)).limit(1)
        : [null];
      const sessionIsActive = !!activeSession && activeSession.status === 'active';
      const attendees: MeetingAttendee[] = meeting.attendees ?? [];
      const isPreInvited = attendees.some(
        (a) => a.email.toLowerCase() === email.toLowerCase(),
      );
      if (sessionIsActive && !isPreInvited) {
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: 'This meeting is locked. New participants are not allowed.' } },
          { status: 403 },
        );
      }
    }

    // Host-control policy: "Waiting room". When enabled, guests join RTK with
    // the GUEST_WAITING preset (waiting_room_type = SKIP_ON_ACCEPT), so the
    // RTK SDK drops them into the native waiting room. The platform host sees
    // them in `meeting.participants.waitlisted` (AdmitGuestsPill) and admits or
    // denies via acceptWaitingRoomRequest / rejectWaitingRoomRequest; the guest
    // portal reacts to the RTK `waitlisted` / `roomJoined` / `roomLeft(rejected)`
    // events. Pre-invited attendees are trusted on the attendees list already
    // and skip straight in with the standard GUEST preset.
    const isPreInvited = (meeting.attendees ?? []).some(
      (a: MeetingAttendee) => a.email.toLowerCase() === email.toLowerCase(),
    );
    const guestPreset =
      meeting.waitingRoom && !isPreInvited ? RTK_PRESETS.GUEST_WAITING : RTK_PRESETS.GUEST;

    // Add guest to meeting attendees if not already present
    const attendees: MeetingAttendee[] = [...(meeting.attendees ?? [])];
    const alreadyAttendee = attendees.some(
      (a) => a.email.toLowerCase() === email.toLowerCase(),
    );
    if (!alreadyAttendee) {
      attendees.push({
        userId: '',
        email,
        name,
        status: 'accepted',
        role: 'attendee',
      });
      await db.update(meetings).set({
        attendees,
        updatedAt: new Date(),
      }).where(eq(meetings.id, meeting.id));
    }

    // Check for active session
    if (!meeting.activeSessionId) {
      return NextResponse.json({
        data: { status: 'waiting' as const, meetingId: meeting.id, meetingTitle: meeting.title },
      });
    }

    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, meeting.activeSessionId))
      .limit(1);

    if (!session || session.status === 'ended') {
      return NextResponse.json({
        data: { status: 'waiting' as const, meetingId: meeting.id, meetingTitle: meeting.title },
      });
    }

    if (!session.cfAppId) {
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: 'Session has no RTK meeting ID' } },
        { status: 500 },
      );
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

    // Update session participants
    const participant: MeetingSessionParticipant = {
      userId: guestUserId,
      userName: name,
      userAvatar: guestAvatarUrl,
      joinedAt: new Date().toISOString(),
      cfSessionId: rtkParticipant.id,
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
      personId,
    };

    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    const filtered = participants.filter((p) => p.userId !== guestUserId);
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

    return NextResponse.json({
      data: {
        status: 'joined' as const,
        sessionId: session.id,
        authToken: rtkParticipant.token,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
      },
    });
  } catch (err) {
    console.error('[MeetingPortal] Failed to join meeting:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to join meeting' } },
      { status: 500 },
    );
  }
}
