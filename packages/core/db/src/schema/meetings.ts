import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Meeting types
export type MeetingType = 'video' | 'audio';
export type MeetingAccessType = 'workspace' | 'invited_only' | 'anyone_with_link';
export type MeetingStatus = 'scheduled' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

// Attendee shape stored in JSONB
export interface MeetingAttendee {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  status: 'pending' | 'accepted' | 'declined' | 'tentative';
  role: 'organizer' | 'attendee';
  /**
   * Set when the attendee was matched to an internal workspace member.
   * Mutually exclusive with `contactId` — the participant resolver guarantees
   * only one is populated per attendee.
   */
  workspaceMemberId?: string;
  /**
   * Set when the attendee was matched to (or auto-created as) a CRM contact.
   * Mutually exclusive with `workspaceMemberId`.
   * @deprecated Use `personId` after the Companies/People migration completes.
   */
  contactId?: string;
  /**
   * Set when the attendee was matched to (or auto-created as) a Person.
   * Mutually exclusive with `workspaceMemberId`. After migration this is the
   * canonical link; `contactId` stays populated as a back-reference.
   */
  personId?: string;
  /**
   * Optional commercial context — which Party (Company or Person) this
   * attendee is on behalf of. Set automatically by the participant resolver
   * for b2b attendees (Company party) and b2c attendees (Person's own party).
   */
  counterpartyId?: string;
}

export const meetings = pgTable('meetings', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Core fields
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),

  // Scheduling link (nullable for instant meetings)
  calendarEventId: varchar('calendar_event_id', { length: 30 }),

  // Ownership
  organizerId: varchar('organizer_id', { length: 255 }).notNull(),

  // Participants (invited attendees with RSVP)
  attendees: jsonb('attendees').$type<MeetingAttendee[]>().default([]),

  // Meeting settings
  meetingType: varchar('meeting_type', { length: 20 }).notNull().default('video'),
  status: varchar('status', { length: 20 }).notNull().default('scheduled'),
  accessType: varchar('access_type', { length: 20 }).notNull().default('workspace'),
  waitingRoom: boolean('waiting_room').default(false),
  allowRecording: boolean('allow_recording').default(true),
  maxParticipants: integer('max_participants'),

  // Host controls — master kill-switch. When false, all per-permission toggles
  // below are ignored and participants get full default access.
  hostManagement: boolean('host_management').default(true),

  // Per-permission policy (apply when hostManagement = true)
  allowScreenShare: boolean('allow_screen_share').default(true),
  allowMicrophone: boolean('allow_microphone').default(true),
  allowVideo: boolean('allow_video').default(true),
  allowHandRaise: boolean('allow_hand_raise').default(true),
  allowReactions: boolean('allow_reactions').default(true),
  allowAnnotations: boolean('allow_annotations').default(true),
  allowVirtualBackgrounds: boolean('allow_virtual_backgrounds').default(true),
  allowParticipantRecord: boolean('allow_participant_record').default(false),
  allowThirdPartyAccess: boolean('allow_third_party_access').default(true),

  // Audio / captions
  noiseCancellation: boolean('noise_cancellation').default(true),
  enableCaptions: boolean('enable_captions').default(false),

  // Lifecycle policy
  autoRecord: boolean('auto_record').default(false),
  hostMustJoinFirst: boolean('host_must_join_first').default(false),
  lockAfterStart: boolean('lock_after_start').default(false),
  autoEndOnInactivity: boolean('auto_end_on_inactivity').default(true),
  autoEndInactivityMinutes: integer('auto_end_inactivity_minutes').default(10),

  // Join link
  joinCode: varchar('join_code', { length: 50 }),

  // @deprecated — Meeting chat now uses meeting_messages table directly. Column kept for backward compat.
  chatChannelId: varchar('chat_channel_id', { length: 30 }),

  // Active session tracking (denormalized for fast lookups)
  activeSessionId: varchar('active_session_id', { length: 30 }),

  // Scheduling
  scheduledStart: timestamp('scheduled_start'),
  scheduledEnd: timestamp('scheduled_end'),

  // Recurrence (for recurring meetings without calendar link)
  isRecurring: boolean('is_recurring').default(false),
  recurrenceRule: varchar('recurrence_rule', { length: 500 }),
  parentMeetingId: varchar('parent_meeting_id', { length: 30 }),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('meetings_organizer_idx').on(table.organizerId),
  index('meetings_calendar_event_idx').on(table.calendarEventId),
  uniqueIndex('meetings_join_code_idx').on(table.joinCode),
  index('meetings_active_session_idx').on(table.activeSessionId),
  index('meetings_status_idx').on(table.status),
  index('meetings_scheduled_start_idx').on(table.scheduledStart),
  index('meetings_deleted_at_idx').on(table.deletedAt),
  index('meetings_parent_meeting_idx').on(table.parentMeetingId),
]);

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
