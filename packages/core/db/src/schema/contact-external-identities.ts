import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * External platform identities linked to a Person.
 *
 * Enables cross-channel resolution: when a Discord or Slack user messages
 * the helpdesk, we can match them to an existing Person by looking up
 * their platform-specific ID here.
 */
export const contactExternalIdentities = pgTable('contact_external_identities', {
  id: varchar('id', { length: 30 }).primaryKey(),
  personId: varchar('person_id', { length: 30 }),
  provider: varchar('provider', { length: 30 }).notNull(), // 'discord' | 'slack' | 'teams' | etc.
  externalId: varchar('external_id', { length: 255 }).notNull(), // Platform user ID
  externalName: varchar('external_name', { length: 255 }), // Display name on platform
  externalEmail: varchar('external_email', { length: 255 }), // Email from platform profile (if available)
  metadata: jsonb('metadata').$type<Record<string, unknown>>(), // avatarUrl, guildId, teamId, etc.
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('contact_ext_id_provider_external_unique').on(table.provider, table.externalId),
  index('contact_ext_id_person_idx').on(table.personId),
  index('contact_ext_id_email_idx').on(table.externalEmail),
]);
