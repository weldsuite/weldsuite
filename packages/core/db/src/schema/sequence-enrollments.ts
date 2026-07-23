import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Sequence Enrollments table
 * Junction table linking customers to sequences (workflows tagged __type:sequence).
 * Tracks enrollment status, progress, and execution linkage.
 */
export const sequenceEnrollments = pgTable('sequence_enrollments', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Foreign keys
  sequenceId: varchar('sequence_id', { length: 30 }).notNull(), // → workflows.id
  customerId: varchar('customer_id', { length: 30 }).notNull(),
  // New — populated by migration backfill. Same id space as customerId
  // (parties), but reads should go through this column after migration.
  counterpartyId: varchar('counterparty_id', { length: 30 }),

  // Status tracking
  status: varchar('status', { length: 20 }).notNull().default('active'),
  // 'pending' | 'active' | 'completed' | 'paused' | 'failed' | 'unenrolled'

  // Execution linkage
  executionId: varchar('execution_id', { length: 30 }),

  // Progress
  currentStepIndex: integer('current_step_index').default(0),
  totalSteps: integer('total_steps').default(0),

  // Enrollment metadata
  enrolledBy: varchar('enrolled_by', { length: 255 }),
  enrolledAt: timestamp('enrolled_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  pausedAt: timestamp('paused_at'),
  unenrolledAt: timestamp('unenrolled_at'),
  failedAt: timestamp('failed_at'),
  errorMessage: varchar('error_message', { length: 1000 }),

  // Snapshot of customer data at enrollment time
  customerSnapshot: jsonb('customer_snapshot').$type<{
    email?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    companyName?: string;
    phone?: string;
    city?: string;
    country?: string;
  }>(),
}, (table) => [
  index('sequence_enrollments_sequence_id_idx').on(table.sequenceId),
  index('sequence_enrollments_customer_id_idx').on(table.customerId),
  index('sequence_enrollments_counterparty_idx').on(table.counterpartyId),
  index('sequence_enrollments_status_idx').on(table.status),
  index('sequence_enrollments_execution_id_idx').on(table.executionId),
  unique('sequence_enrollments_unique_idx').on(table.sequenceId, table.customerId),
]);

export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
export type NewSequenceEnrollment = typeof sequenceEnrollments.$inferInsert;
