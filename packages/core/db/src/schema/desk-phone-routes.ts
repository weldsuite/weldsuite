import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Per-number inbound routing for WeldDesk phone channel.
 * One active route per voip_phone_numbers row.
 */

export const DESK_PHONE_ROUTE_ACTIONS = ['ai_agent', 'forward', 'hangup'] as const;
export type DeskPhoneRouteAction = (typeof DESK_PHONE_ROUTE_ACTIONS)[number];

/** Optional always-on schedule; empty/null means always active (MVP). */
export interface DeskPhoneRouteSchedule {
  timezone?: string;
  /** 0=Sun … 6=Sat */
  daysOfWeek?: number[];
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
}

export const deskPhoneRoutes = pgTable(
  'desk_phone_routes',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    voipPhoneNumberId: varchar('voip_phone_number_id', { length: 30 }).notNull(),

    action: varchar('action', { length: 20 }).$type<DeskPhoneRouteAction>().notNull().default('hangup'),

    voiceAgentId: varchar('voice_agent_id', { length: 30 }),
    forwardToE164: varchar('forward_to_e164', { length: 50 }),

    schedule: jsonb('schedule').$type<DeskPhoneRouteSchedule | null>(),
  },
  (table) => [
    uniqueIndex('desk_phone_routes_number_uidx').on(table.voipPhoneNumberId),
    index('desk_phone_routes_action_idx').on(table.action),
    index('desk_phone_routes_agent_idx').on(table.voiceAgentId),
  ],
);

export type DeskPhoneRoute = typeof deskPhoneRoutes.$inferSelect;
export type NewDeskPhoneRoute = typeof deskPhoneRoutes.$inferInsert;
