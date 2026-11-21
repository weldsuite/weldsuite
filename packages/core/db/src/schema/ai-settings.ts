/**
 * AI settings: which AI providers a workspace allows, and the workspace's own
 * provider keys. Tenant DB.
 *
 * Used by the Rust backend (EU and self-hosted editions, ADR AI-012); the
 * tables stay empty on Global. Plan: `weldsuite-documentation/plans/eu-ai-mistral.md`.
 *
 * - `ai_settings` is a singleton: one row per workspace database.
 * - `ai_provider_keys` holds a workspace's own key per provider, encrypted with
 *   `AI_KEYS_ENCRYPTION_KEY`. Only the hint (last characters) is ever shown.
 */

import { pgTable, varchar, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

/** Providers a workspace can enable. `mistral` is EU; the others are outside the EU. */
export type AiProviderId = 'mistral' | 'anthropic' | 'openai' | 'compat';

/** Whose account pays for the calls to a provider. */
export type AiKeySource = 'weldsuite' | 'own';

/** One entry of `ai_settings.providers`, keyed by provider id. */
export type AiProviderSetting = {
  enabled: boolean;
  keySource: AiKeySource;
  /** User id of the admin who enabled it. */
  enabledBy?: string;
  /** ISO timestamp. */
  enabledAt?: string;
};

/** One entry of `ai_settings.feature_overrides`, keyed by feature id (`mail`, `forms`, …). */
export type AiFeatureOverride = {
  provider: AiProviderId;
  /** Canonical model id (`anthropic/claude-sonnet-5-5`), or null for the provider's default. */
  model: string | null;
};

export const aiSettings = pgTable('ai_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  /** `{ "anthropic": { enabled, keySource, enabledBy, enabledAt } }` */
  providers: jsonb('providers').$type<Record<string, AiProviderSetting>>().notNull().default({}),
  /** Workspace default provider; null means the install default. */
  defaultProvider: varchar('default_provider', { length: 32 }),
  /** `{ "mail": { provider, model } }` */
  featureOverrides: jsonb('feature_overrides')
    .$type<Record<string, AiFeatureOverride>>()
    .notNull()
    .default({}),

  updatedBy: varchar('updated_by', { length: 255 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiProviderKeys = pgTable(
  'ai_provider_keys',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    provider: varchar('provider', { length: 32 }).notNull(),
    /** The key, encrypted with `AI_KEYS_ENCRYPTION_KEY`. Never returned by an API. */
    ciphertext: text('ciphertext').notNull(),
    /** Last characters of the key, for display. */
    keyHint: varchar('key_hint', { length: 32 }).notNull(),
    /** `ok` | `failing` */
    status: varchar('status', { length: 16 }).notNull().default('ok'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ai_provider_keys_provider_idx').on(table.provider)],
);

export type AiSettingsRow = typeof aiSettings.$inferSelect;
export type NewAiSettingsRow = typeof aiSettings.$inferInsert;
export type AiProviderKeyRow = typeof aiProviderKeys.$inferSelect;
export type NewAiProviderKeyRow = typeof aiProviderKeys.$inferInsert;
