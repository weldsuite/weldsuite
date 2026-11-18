const HOUR_MS = 60 * 60 * 1000;

interface MeetingTiming {
  status?: string | null;
  scheduledStart?: string | Date | null;
  scheduledEnd?: string | Date | null;
}

/**
 * Whether the Upcoming list shows the meeting, by the rule its `?view=upcoming`
 * query uses on the server: a running meeting, or a scheduled one until its
 * end (its start + 1 hour without an end). One without a start ("for later")
 * stays there. Everything else is in History.
 */
export function isListedAsUpcoming(meeting: MeetingTiming, now: Date = new Date()): boolean {
  if (meeting.status === 'in_progress') return true;
  if (meeting.status !== 'scheduled') return false;
  if (!meeting.scheduledStart) return true;
  const end = meeting.scheduledEnd
    ? new Date(meeting.scheduledEnd).getTime()
    : new Date(meeting.scheduledStart).getTime() + HOUR_MS;
  return end >= now.getTime();
}
