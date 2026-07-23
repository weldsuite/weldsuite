import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — teams (= team inboxes) and per-teammate inbox settings.
 *
 * Replaces helpdesk_departments + helpdesk_agents. A team IS a team inbox
 * (Intercom model). Teammates can belong to multiple teams.
 */

export type DeskDistributionMethod = 'manual' | 'round_robin' | 'balanced';

export interface DeskWeeklyHours {
  /** 0 = Sunday … 6 = Saturday. Times are "HH:mm" in the configured timezone. */
  [day: string]: { start: string; end: string }[] | undefined;
}

export const deskTeams = pgTable(
  'desk_teams',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    icon: varchar('icon', { length: 20 }),
    /** Clerk user ids of the teammates in this inbox. */
    memberIds: jsonb('member_ids').$type<string[]>().notNull().default([]),

    distributionMethod: varchar('distribution_method', { length: 15 })
      .$type<DeskDistributionMethod>()
      .notNull()
      .default('manual'),
    /** Max open conversations assigned across the whole inbox (balanced). Null = unlimited. */
    teamLimit: integer('team_limit'),
    /** Round robin: also assign to teammates who are Away. */
    ignoreAwayStatus: boolean('ignore_away_status').notNull().default(false),

    /** Per-team office-hours override; null = use workspace default. */
    officeHours: jsonb('office_hours').$type<{ timezone: string; hours: DeskWeeklyHours }>(),
    /** Shown to customers in the Messenger, e.g. 'few_minutes' | 'few_hours' | 'one_day'. */
    expectedReplyTime: varchar('expected_reply_time', { length: 20 }),

    /** Rank used as the final tiebreak in the balanced-assignment queue. */
    inboxRank: integer('inbox_rank').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_teams_archived_idx').on(table.archived)],
);

export type DeskTeammateStatus = 'active' | 'away' | 'away_reassign';

export const deskTeammateSettings = pgTable(
  'desk_teammate_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** Clerk user id. */
    userId: varchar('user_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 15 }).$type<DeskTeammateStatus>().notNull().default('active'),
    /** Max open conversations for balanced assignment. Null = workspace default. */
    assignmentLimit: integer('assignment_limit'),
    /** Longest-since-last-assignment tiebreak for balanced assignment. */
    lastAssignedAt: timestamp('last_assigned_at'),
    notificationPreferences: jsonb('notification_preferences').$type<Record<string, boolean>>(),
  },
  (table) => [uniqueIndex('desk_teammate_settings_user_idx').on(table.userId)],
);

export type DeskTeam = typeof deskTeams.$inferSelect;
export type NewDeskTeam = typeof deskTeams.$inferInsert;
export type DeskTeammateSettings = typeof deskTeammateSettings.$inferSelect;
export type NewDeskTeammateSettings = typeof deskTeammateSettings.$inferInsert;
