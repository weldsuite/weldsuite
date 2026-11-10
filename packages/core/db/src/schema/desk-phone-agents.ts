import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
} from 'drizzle-orm/pg-core';

/**
 * A member who takes WeldDesk phone calls in the browser.
 *
 * Every member gets their own Telnyx telephony credential, so an inbound call
 * can ring one person's browser: the server dials `sip:<sipUsername>@sip.telnyx.com`
 * and only the browsers signed in with that credential ring. The row is
 * created the first time the member asks for a softphone token.
 *
 * `available` is the member's own switch ("take calls"). Whether they are
 * rung also depends on them being online and not on another call.
 */
export const deskPhoneAgents = pgTable('desk_phone_agents', {
  /** The member's user id (workspace_members.user_id). */
  userId: varchar('user_id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  /** Telnyx telephony credential id; tokens are minted from it. */
  telnyxCredentialId: varchar('telnyx_credential_id', { length: 100 }),
  /** The credential's SIP username, the address the server dials to ring this member. */
  sipUsername: varchar('sip_username', { length: 255 }),

  available: boolean('available').notNull().default(false),
});

export type DeskPhoneAgent = typeof deskPhoneAgents.$inferSelect;
export type NewDeskPhoneAgent = typeof deskPhoneAgents.$inferInsert;

export const DESK_PHONE_CALL_LEG_STATUSES = ['ringing', 'answered', 'ended'] as const;
export type DeskPhoneCallLegStatus = (typeof DESK_PHONE_CALL_LEG_STATUSES)[number];

/**
 * One agent's browser being rung for a waiting call (a Telnyx call leg the
 * server dialled). Several legs ring at once; the first to answer is bridged
 * to the caller and the others are hung up. A row per leg, so the webhooks of
 * different legs never write the same row.
 */
export const deskPhoneCallLegs = pgTable(
  'desk_phone_call_legs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /** The waiting call (voip_calls.id). */
    callId: varchar('call_id', { length: 30 }).notNull(),
    /** The member being rung. */
    userId: varchar('user_id', { length: 255 }).notNull(),
    /** Telnyx call_control_id of the leg, set once the dial is accepted. */
    providerCallId: varchar('provider_call_id', { length: 255 }),

    status: varchar('status', { length: 20 }).$type<DeskPhoneCallLegStatus>().notNull().default('ringing'),
    endedAt: timestamp('ended_at'),
  },
  (table) => [
    index('desk_phone_call_legs_call_idx').on(table.callId),
    index('desk_phone_call_legs_user_status_idx').on(table.userId, table.status),
  ],
);

export type DeskPhoneCallLeg = typeof deskPhoneCallLegs.$inferSelect;
export type NewDeskPhoneCallLeg = typeof deskPhoneCallLegs.$inferInsert;
