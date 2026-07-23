/**
 * WeldMeet + calendar/booking entity events.
 */
export const MEETINGS_ENTITY_EVENTS = {
  calendar: ['created', 'updated', 'deleted'],
  calendar_booking: ['created', 'updated', 'deleted', 'cancelled', 'completed'],
  calendar_booking_page: ['created', 'updated', 'deleted'],
  calendar_event: ['created', 'updated', 'deleted', 'cancelled'],
  calendar_share: ['created', 'updated', 'deleted'],
  meeting: ['created', 'updated', 'deleted', 'started', 'completed', 'cancelled'],
  meeting_bot_session: ['created', 'updated', 'deleted', 'started', 'completed'],
  meeting_session: ['created', 'updated', 'deleted', 'started', 'completed'],
  meeting_message: ['created', 'updated', 'deleted'],
  meeting_waitlist: ['created', 'updated', 'deleted', 'admitted'],
} as const;
