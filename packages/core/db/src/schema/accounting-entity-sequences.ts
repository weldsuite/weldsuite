import {
  pgTable,
  varchar,
  timestamp,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const entityNumberSequences = pgTable('entity_number_sequences', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  sequenceType: varchar('sequence_type', { length: 20 }).notNull(),
  prefix: varchar('prefix', { length: 20 }).notNull().default(''),
  nextValue: integer('next_value').notNull().default(1),
  padding: integer('padding').default(0),
}, (table) => [
  uniqueIndex('entity_sequences_unique').on(table.entityId, table.sequenceType),
]);

export type EntityNumberSequence = typeof entityNumberSequences.$inferSelect;
export type NewEntityNumberSequence = typeof entityNumberSequences.$inferInsert;
