import { eq, and, isNull } from 'drizzle-orm';
import { meetings, meetingSessions } from '@weldsuite/db/schema';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';

/**
 * Verify the guest is currently a participant of the meeting's active session.
 * Returns the matched participant (with userName + userAvatar) or null.
 *
 * Shared by the guest chat message + upload routes so a guest can only post /
 * upload to a meeting they are actually in.
 */
export async function verifyGuestParticipant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  meetingId: string,
  email: string,
): Promise<MeetingSessionParticipant | null> {
  const [meeting] = await db
    .select({ activeSessionId: meetings.activeSessionId })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)))
    .limit(1);

  if (!meeting?.activeSessionId) return null;

  const [session] = await db
    .select({ participants: meetingSessions.participants, status: meetingSessions.status })
    .from(meetingSessions)
    .where(eq(meetingSessions.id, meeting.activeSessionId))
    .limit(1);

  if (!session || session.status === 'ended') return null;

  const guestUserId = `guest:${email.toLowerCase()}`;
  const participants: MeetingSessionParticipant[] = session.participants ?? [];
  const match = participants.find(
    (p) => p.userId.toLowerCase() === guestUserId && !p.leftAt,
  );
  return match ?? null;
}
