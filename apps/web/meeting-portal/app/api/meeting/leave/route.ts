import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetingSessions } from '@weldsuite/db/schema';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { endMeetingSession } from '@weldsuite/meet-domain/meeting-lifecycle';
import { guestLeaveInputSchema } from '@/lib/schemas';
import { guestUnauthorized, invalidInput, tenantNotFoundResponse } from '@/lib/api-response';
import { authenticateGuest, isTokenParticipant } from '@/lib/guest-session';
import { meetingLifecycleEnv } from '@/lib/meeting-lifecycle-env';

/**
 * POST /api/meeting/leave
 * Authorization: Bearer <guest session token from /api/meeting/join>
 * Body: { orgId, meetingId }
 * Marks the token's guest as left in the session the token was issued for. When
 * nobody is left in the room the session is ended through the shared
 * `endMeetingSession` (the same code the platform's leave / end routes and the
 * RealtimeKit webhook run): participants stamped as left, meeting released,
 * RealtimeKit room torn down, CRM activity logged, platform notified.
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

  const parsed = guestLeaveInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const { orgId, meetingId } = parsed.data;

  const claims = authenticateGuest(request.headers, orgId, meetingId);
  if (!claims) return guestUnauthorized();
  const { sessionId } = claims;

  try {
    const { db, clerkOrgId } = await getTenantDb(orgId);

    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, sessionId))
      .limit(1);

    if (!session || session.meetingId !== meetingId) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Session not found' } },
        { status: 404 },
      );
    }

    // Already ended (the host ended it, or another guest was last out): the
    // end has run, and every kicked guest's leave lands here. Nothing to do.
    if (session.status === 'ended') {
      return NextResponse.json({ data: { ok: true } });
    }

    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    // Match on the RTK participant too, so a stale token from an earlier join
    // cannot mark a newer connection of the same guest as left.
    const idx = participants.findIndex((p) => isTokenParticipant(p, claims));
    if (idx < 0 || participants[idx].leftAt) {
      return NextResponse.json({ data: { ok: true } });
    }
    participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };

    const activeParticipants = participants.filter((p) => !p.leftAt);

    // Conditional on the session still being open: if the host (or the RTK
    // webhook) ended it since the read above, this stale snapshot must not
    // overwrite the ended row's participants (the end stamped everyone's leftAt).
    const updated = await db
      .update(meetingSessions)
      .set({ participants, updatedAt: new Date() })
      .where(and(eq(meetingSessions.id, sessionId), ne(meetingSessions.status, 'ended')))
      .returning({ id: meetingSessions.id });
    if (updated.length === 0) {
      return NextResponse.json({ data: { ok: true } });
    }

    // Auto-end if no participants remain.
    if (activeParticipants.length === 0) {
      await endMeetingSession(
        db,
        meetingLifecycleEnv(),
        // The realtime hub is keyed by the Clerk org id, which is not always the URL's id.
        clerkOrgId ?? orgId,
        sessionId,
        session,
        meetingId,
      );
    }

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    const notFound = tenantNotFoundResponse(err);
    if (notFound) return notFound;
    console.error('[MeetingPortal] Failed to leave session:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to leave session' } },
      { status: 500 },
    );
  }
}
