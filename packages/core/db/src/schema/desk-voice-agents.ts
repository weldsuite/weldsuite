import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk voice agents — Telnyx AI Assistants mirrored into the tenant DB.
 * Prompt/greeting/transfer config is source of truth; telnyxAssistantId is
 * the remote id used by Call Control `ai_assistant_start`.
 */

export const deskVoiceAgents = pgTable(
  'desk_voice_agents',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    systemPrompt: text('system_prompt').notNull(),
    greeting: text('greeting'),

    /** Telnyx AI Assistant id (`assistant-…`). Null until first successful sync. */
    telnyxAssistantId: varchar('telnyx_assistant_id', { length: 100 }),

    enabled: boolean('enabled').notNull().default(true),

    /** Default cold-transfer destination when the AI uses the Transfer tool. */
    forwardToE164: varchar('forward_to_e164', { length: 50 }),

    model: varchar('model', { length: 100 }),
    voice: varchar('voice', { length: 100 }),

    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('desk_voice_agents_enabled_idx').on(table.enabled),
    index('desk_voice_agents_telnyx_idx').on(table.telnyxAssistantId),
  ],
);

export type DeskVoiceAgent = typeof deskVoiceAgents.$inferSelect;
export type NewDeskVoiceAgent = typeof deskVoiceAgents.$inferInsert;
