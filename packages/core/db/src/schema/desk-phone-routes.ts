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

/**
 * What a number does with an inbound call:
 *   - `ai_agent`: the AI voice agent answers.
 *   - `forward`: transfer to another number.
 *   - `hangup`: no route.
 *   - `agents`: ring the available agents in their browser; the caller waits
 *     in the queue until one answers.
 *   - `voicemail`: play the greeting and record a message.
 *   - `menu`: a keypad menu ("press 1 for sales") in front of the others.
 */
export const DESK_PHONE_ROUTE_ACTIONS = ['ai_agent', 'forward', 'hangup', 'agents', 'voicemail', 'menu'] as const;
export type DeskPhoneRouteAction = (typeof DESK_PHONE_ROUTE_ACTIONS)[number];

/** What a keypad choice can do. A menu never leads to another menu or to a hangup. */
export const DESK_PHONE_MENU_ACTIONS = ['ai_agent', 'agents', 'forward', 'voicemail'] as const;
export type DeskPhoneMenuAction = (typeof DESK_PHONE_MENU_ACTIONS)[number];

/** The keys a caller can press. */
export const DESK_PHONE_MENU_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'] as const;
export type DeskPhoneMenuDigit = (typeof DESK_PHONE_MENU_DIGITS)[number];

export const DESK_PHONE_UNANSWERED_ACTIONS = ['voicemail', 'hangup'] as const;
export type DeskPhoneUnansweredAction = (typeof DESK_PHONE_UNANSWERED_ACTIONS)[number];

/** One key of the keypad menu and where it sends the caller. */
export interface DeskPhoneMenuChoice {
  digit: DeskPhoneMenuDigit;
  /** Shown in settings and reports ("Sales"); the caller hears the menu prompt, not this. */
  label?: string;
  action: DeskPhoneMenuAction;
  /** `ai_agent`. */
  voiceAgentId?: string;
  /** `agents`: the team whose members ring; absent or null rings every available agent. */
  departmentId?: string | null;
  /** `forward`. */
  forwardToE164?: string;
}

export interface DeskPhoneMenu {
  /** Spoken to the caller: "Press 1 for sales, press 2 for support." */
  prompt: string;
  choices: DeskPhoneMenuChoice[];
  /**
   * The choice that runs when the caller presses nothing, or a key that is
   * not on the menu, after the prompt has played twice. Null hangs up.
   */
  fallbackDigit?: DeskPhoneMenuDigit | null;
}

/** Settings of a route beyond its action; every field is optional. */
export interface DeskPhoneRouteOptions {
  /** Spoken when the call is answered, before agents ring. */
  greeting?: string;
  /** Language of the spoken texts, as a BCP 47 tag (`en-US`, `nl-NL`). */
  language?: string;
  /** `agents`: the team whose members ring; absent or null rings every available agent. */
  departmentId?: string | null;
  /** `agents`: how long an agent's browser rings before the round ends. */
  ringSeconds?: number;
  /** `agents`: how long a caller waits before `whenUnanswered` applies. */
  maxWaitSeconds?: number;
  /** `agents`: what happens when nobody answers in time, or nobody is available. */
  whenUnanswered?: DeskPhoneUnansweredAction;
  /** Spoken before the beep. */
  voicemailGreeting?: string;
  /** `menu`. */
  menu?: DeskPhoneMenu;
}

export const DESK_PHONE_DEFAULT_RING_SECONDS = 25;
export const DESK_PHONE_DEFAULT_MAX_WAIT_SECONDS = 300;

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

    /** Ring, queue, voicemail and keypad-menu settings; null for the plain actions. */
    options: jsonb('options').$type<DeskPhoneRouteOptions | null>(),
  },
  (table) => [
    uniqueIndex('desk_phone_routes_number_uidx').on(table.voipPhoneNumberId),
    index('desk_phone_routes_action_idx').on(table.action),
    index('desk_phone_routes_agent_idx').on(table.voiceAgentId),
  ],
);

export type DeskPhoneRoute = typeof deskPhoneRoutes.$inferSelect;
export type NewDeskPhoneRoute = typeof deskPhoneRoutes.$inferInsert;
