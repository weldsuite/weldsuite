import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Return status types
export type ReturnStatus =
  | 'requested'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'label_created'
  | 'shipped'
  | 'received'
  | 'inspecting'
  | 'processed'
  | 'refunded'
  | 'exchanged'
  | 'cancelled';

export type ReturnCondition = 'new' | 'opened' | 'damaged' | 'defective';
export type ReturnMethod = 'label' | 'dropoff' | 'pickup';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Money {
  amount: number;
  currency: string;
}

export interface ReturnItem {
  productId?: string;
  productName: string;
  sku?: string;
  quantity: number;
  reason?: string;
  condition?: ReturnCondition;
}

export interface ReturnResolution {
  type: 'refund' | 'exchange' | 'store_credit' | 'repair';
  amount?: Money;
  notes?: string;
  processedAt?: Date;
  processedBy?: string;
}

export const returns = pgTable('returns', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  returnNumber: varchar('return_number', { length: 50 }).notNull(),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('requested'),

  // Original Order
  originalOrderId: varchar('original_order_id', { length: 30 }),
  originalTrackingNumber: varchar('original_tracking_number', { length: 100 }),

  // Customer
  customerId: varchar('customer_id', { length: 30 }),
  customerName: varchar('customer_name', { length: 255 }),
  customerEmail: varchar('customer_email', { length: 255 }),
  customerPhone: varchar('customer_phone', { length: 50 }),

  // Return Details
  reason: varchar('reason', { length: 100 }),
  reasonDetails: text('reason_details'),
  condition: varchar('condition', { length: 20 }),

  // Items
  items: jsonb('items').$type<ReturnItem[]>(),

  // Shipping
  returnParcelId: varchar('return_parcel_id', { length: 30 }),
  returnTrackingNumber: varchar('return_tracking_number', { length: 100 }),
  returnLabelUrl: varchar('return_label_url', { length: 500 }),
  returnCarrier: varchar('return_carrier', { length: 100 }),
  returnMethod: varchar('return_method', { length: 20 }).default('label'),

  // Processing Dates
  receivedAt: timestamp('received_at'),
  inspectedAt: timestamp('inspected_at'),
  processedAt: timestamp('processed_at'),

  // Resolution
  resolution: jsonb('resolution').$type<ReturnResolution>(),
  refundAmount: jsonb('refund_amount').$type<Money>(),
  replacementOrderId: varchar('replacement_order_id', { length: 30 }),

  // Notes
  customerNotes: text('customer_notes'),
  internalNotes: text('internal_notes'),

  // Approval
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending'),
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),
}, (table) => [
  index('returns_return_number_idx').on(table.returnNumber),
  index('returns_status_idx').on(table.status),
  index('returns_customer_id_idx').on(table.customerId),
  index('returns_original_order_id_idx').on(table.originalOrderId),
  index('returns_created_at_idx').on(table.createdAt),
]);

export type Return = typeof returns.$inferSelect;
export type NewReturn = typeof returns.$inferInsert;
