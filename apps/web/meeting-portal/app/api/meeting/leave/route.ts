import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getTenantDb } from '@/lib/db';
import { meetings, meetingSessions } from '@weldsuite/db/schema';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { guestLeaveInputSchema } from '@/lib/schemas';
import { invalidInput } from '@/lib/api-response';

/**
 * POST /api/meeting/leave
 * Guest leaves a meeting session.
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
  const { orgId, meetingId, sessionId, email } = parsed.data;

  try {
    const { db } = await getTenantDb(orgId);

    const [session] = await db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.id, sessionId))
      .limit(1);

    if (!session) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Session not found' } },
        { status: 404 },
      );
    }

    const guestUserId = `guest:${email}`;
    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    const idx = participants.findIndex((p) => p.userId === guestUserId);
    if (idx >= 0) {
      participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
    }

    const activeParticipants = participants.filter((p) => !p.leftAt);

    await db.update(meetingSessions).set({
      participants,
      updatedAt: new Date(),
    }).where(eq(meetingSessions.id, sessionId));

    // Auto-end if no participants remain
    if (activeParticipants.length === 0) {
      const now = new Date();
      const duration = session.startedAt
        ? Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000)
        : 0;

      await db.update(meetingSessions).set({
        status: 'ended',
        endedAt: now,
        duration,
        updatedAt: now,
      }).where(eq(meetingSessions.id, sessionId));

      const [meeting] = await db
        .select({ scheduledEnd: meetings.scheduledEnd, scheduledStart: meetings.scheduledStart })
        .from(meetings)
        .where(eq(meetings.id, meetingId))
        .limit(1);

      const isPast = meeting?.scheduledEnd
        ? new Date(meeting.scheduledEnd).getTime() < now.getTime()
        : meeting?.scheduledStart
          ? new Date(meeting.scheduledStart).getTime() < now.getTime() - 60 * 60_000
          : true;

      await db.update(meetings).set({
        activeSessionId: null,
        status: isPast ? 'completed' : 'scheduled',
        updatedAt: now,
      }).where(eq(meetings.id, meetingId));
    }

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error('[MeetingPortal] Failed to leave session:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to leave session' } },
      { status: 500 },
    );
  }
}
