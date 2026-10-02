type MeetingSchedule = {
  scheduledEnd: Date | string | null;
  scheduledStart: Date | string | null;
};

function isScheduled(meeting: MeetingSchedule): boolean {
  return !!meeting.scheduledStart || !!meeting.scheduledEnd;
}

/**
 * A scheduled meeting is past once its end (or, without one, start + 1h) has
 * elapsed. Unscheduled meetings ("Create a meeting for later", instant
 * meetings) are reusable rooms and are never past. Mirrors isMeetingPast in
 * apps/workers/meet-api/src/services/weldmeet/meeting-lifecycle.ts.
 */
export function isMeetingPast(meeting: MeetingSchedule | undefined, now: Date): boolean {
  if (meeting?.scheduledEnd) return new Date(meeting.scheduledEnd).getTime() < now.getTime();
  if (meeting?.scheduledStart) return new Date(meeting.scheduledStart).getTime() < now.getTime() - 60 * 60_000;
  return false;
}

/**
 * The status a guest should see. Unscheduled meetings closed as 'completed'
 * before reusable links existed report 'scheduled', so their old links work
 * again instead of showing "This meeting has already ended" forever.
 */
export function effectiveMeetingStatus(meeting: MeetingSchedule & { status: string }): string {
  if (meeting.status === 'completed' && !isScheduled(meeting)) return 'scheduled';
  return meeting.status;
}
