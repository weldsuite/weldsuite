import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { DeskPriority } from './desk-conversations';

/**
 * Who decides an approval step:
 *   - `member`: one named workspace member (`approverId`, a user id).
 *   - `team_manager`: the manager of a team (`departmentId`), or of the
 *     request's own team when no team is named.
 */
export const DESK_CATALOG_APPROVER_TYPES = ['member', 'team_manager'] as const;
export type DeskCatalogApproverType = (typeof DESK_CATALOG_APPROVER_TYPES)[number];

/** One approval step of a catalogue item; steps are decided in order. */
export interface DeskCatalogApprovalStep {
  /** Stable within the item, so a step keeps its identity when steps are reordered. */
  id: string;
  /** Shown to the approver and on the timeline ("Budget approval"). */
  name?: string;
  approverType: DeskCatalogApproverType;
  /** `member`: the approver's user id. */
  approverId?: string;
  /** `team_manager`: the team whose manager approves; absent uses the request's team. */
  departmentId?: string | null;
}

/** A WeldFlow task created when a request is approved (or right away, without approval). */
export interface DeskCatalogFulfilmentTask {
  id: string;
  title: string;
  description?: string;
  /** The member who gets the task (a user id); absent gives it to the request's owner. */
  assigneeId?: string | null;
  /** Due this many days after the request is approved. */
  dueInDays?: number | null;
}

export const DESK_CATALOG_MAX_APPROVAL_STEPS = 5;
export const DESK_CATALOG_MAX_FULFILMENT_TASKS = 20;

/**
 * A service catalogue item: something a customer or colleague can request
 * (a laptop, access to a system, a new mailbox).
 *
 * The form is the item's ticket type (helpdesk_ticket_types): its
 * customer-visible fields are what the requester fills in, exactly as on a
 * help-center request. A request is an inbox conversation with
 * `catalog_item_id` set.
 *
 * approvalSteps: decided in order before fulfilment starts; empty means no
 * approval. fulfilmentTasks: WeldFlow tasks created once the request is
 * approved, linked to the conversation (`tasks.source_type` /
 * `source_id`).
 *
 * audienceCompanyIds: the CRM companies whose people see the item in the
 * help center; empty shows it to every signed-in reader.
 */
export const deskCatalogItems = pgTable(
  'desk_catalog_items',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    /** One or two lines under the name in the catalogue. */
    summary: varchar('summary', { length: 500 }),
    /** What the requester reads above the form. */
    description: text('description'),
    /** Free-text grouping in the catalogue ("Hardware", "Access"). */
    category: varchar('category', { length: 100 }),
    /** A lucide icon name. */
    icon: varchar('icon', { length: 50 }),

    ticketTypeId: varchar('ticket_type_id', { length: 30 }).notNull(),
    /** The team that fulfils it; null uses the ticket type's default team. */
    departmentId: varchar('department_id', { length: 30 }),
    /** Null uses the ticket type's default priority. */
    priority: varchar('priority', { length: 10 }).$type<DeskPriority>(),
    /** Shown to the requester ("2 working days"). */
    deliveryEstimate: varchar('delivery_estimate', { length: 100 }),

    approvalSteps: jsonb('approval_steps').$type<DeskCatalogApprovalStep[]>().notNull().default([]),
    fulfilmentTasks: jsonb('fulfilment_tasks').$type<DeskCatalogFulfilmentTask[]>().notNull().default([]),

    audienceCompanyIds: jsonb('audience_company_ids').$type<string[]>().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [
    index('desk_catalog_items_active_idx').on(table.isActive, table.sortOrder),
    index('desk_catalog_items_type_idx').on(table.ticketTypeId),
  ],
);

export type DeskCatalogItem = typeof deskCatalogItems.$inferSelect;
export type NewDeskCatalogItem = typeof deskCatalogItems.$inferInsert;

/**
 * Where a request stands with its approvers (`desk_conversations.approval_status`):
 * `pending` while a step waits for its approver, `approved` once every step
 * said yes, `rejected` as soon as one said no. Null: the item needs no approval.
 */
export const DESK_REQUEST_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DeskRequestApprovalStatus = (typeof DESK_REQUEST_APPROVAL_STATUSES)[number];

/**
 *   - `waiting`: an earlier step has to be decided first.
 *   - `pending`: this step is with its approver.
 *   - `approved` / `rejected`: decided.
 *   - `skipped`: an earlier step was rejected, so nobody was asked.
 */
export const DESK_APPROVAL_STEP_STATUSES = ['waiting', 'pending', 'approved', 'rejected', 'skipped'] as const;
export type DeskApprovalStepStatus = (typeof DESK_APPROVAL_STEP_STATUSES)[number];

/**
 * One approval step of one request, copied from the item when the request
 * is made: a later change to the item never changes who has to approve a
 * request that is already under way.
 *
 * approverId is resolved at that moment too (a team's manager then), and is
 * null when the step had nobody to ask; such a step is decided by anyone who
 * manages the catalogue.
 */
export const deskRequestApprovals = pgTable(
  'desk_request_approvals',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    catalogItemId: varchar('catalog_item_id', { length: 30 }).notNull(),

    stepIndex: integer('step_index').notNull(),
    stepName: varchar('step_name', { length: 255 }),
    /** The member asked to decide (a user id). */
    approverId: varchar('approver_id', { length: 255 }),

    status: varchar('status', { length: 10 }).$type<DeskApprovalStepStatus>().notNull().default('waiting'),
    decidedAt: timestamp('decided_at'),
    /** Who decided; differs from approverId when a catalogue manager stepped in. */
    decidedById: varchar('decided_by_id', { length: 255 }),
    comment: text('comment'),
  },
  (table) => [
    index('desk_request_approvals_conversation_idx').on(table.conversationId, table.stepIndex),
    index('desk_request_approvals_approver_idx').on(table.approverId, table.status),
  ],
);

export type DeskRequestApproval = typeof deskRequestApprovals.$inferSelect;
export type NewDeskRequestApproval = typeof deskRequestApprovals.$inferInsert;
