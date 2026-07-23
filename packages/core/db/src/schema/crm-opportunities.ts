import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

export interface OpportunityLineItem {
  id: string;
  productId?: string;
  productName: string;
  description?: string;
  quantity: number;
  unitPrice: { amount: number; currency: string };
  discount?: number;
  total: { amount: number; currency: string };
}

export interface Competitor {
  name: string;
  strengths?: string;
  weaknesses?: string;
  strategy?: string;
}

export const crmOpportunities = pgTable('crm_opportunities', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Information
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Customer (legacy — kept during Companies/People migration)
  customerId: varchar('customer_id', { length: 30 }).notNull(),
  customerName: varchar('customer_name', { length: 255 }),
  contactIds: jsonb('contact_ids').$type<string[]>(), // string[]
  primaryContactId: varchar('primary_contact_id', { length: 30 }),

  // Counterparty + people (new — populated by migration backfill, then
  // becomes the canonical FK in the post-refactor reads/writes).
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personIds: jsonb('person_ids').$type<string[]>(), // string[]
  primaryPersonId: varchar('primary_person_id', { length: 30 }),

  // Value (using numeric for money precision)
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  expectedRevenue: numeric('expected_revenue', { precision: 18, scale: 2 }),
  recurringRevenue: numeric('recurring_revenue', { precision: 18, scale: 2 }),
  contractLength: integer('contract_length'), // months

  // Sales Process
  stageId: varchar('stage_id', { length: 30 }), // Reference to crm_pipeline_stages
  stage: varchar('stage', { length: 50 }).notNull().default('prospecting'), // 'prospecting' | 'qualification' | 'needs_analysis' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'
  probability: integer('probability').default(0), // 0-100
  pipeline: varchar('pipeline', { length: 100 }).default('default'),
  salesProcess: varchar('sales_process', { length: 100 }),

  // Dates
  closeDate: timestamp('close_date').notNull(),
  actualCloseDate: timestamp('actual_close_date'),
  startDate: timestamp('start_date'),

  // Competition
  competitors: jsonb('competitors').$type<Competitor[]>(), // Competitor[]
  competitionStatus: varchar('competition_status', { length: 20 }), // 'ahead' | 'even' | 'behind' | 'unknown'
  winLossReason: varchar('win_loss_reason', { length: 500 }),

  // Products/Services
  lineItems: jsonb('line_items').$type<OpportunityLineItem[]>(), // OpportunityLineItem[]

  // Team
  ownerId: varchar('owner_id', { length: 255 }).notNull(), // Clerk user ID
  teamMembers: jsonb('team_members').$type<string[]>(), // string[]

  // Source
  leadSource: varchar('lead_source', { length: 100 }),
  campaign: varchar('campaign', { length: 255 }),

  // Type
  type: varchar('type', { length: 30 }), // 'new_business' | 'existing_business' | 'renewal' | 'upgrade' | 'downgrade'
  category: varchar('category', { length: 100 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('open'), // 'open' | 'won' | 'lost' | 'abandoned'
  forecastCategory: varchar('forecast_category', { length: 20 }), // 'pipeline' | 'best_case' | 'commit' | 'closed'

  // Next Steps
  nextStep: varchar('next_step', { length: 500 }),
  nextStepDate: timestamp('next_step_date'),

  // Risk
  riskLevel: varchar('risk_level', { length: 10 }), // 'high' | 'medium' | 'low' | 'none'
  riskReason: varchar('risk_reason', { length: 500 }),

  // Documents
  proposalUrl: varchar('proposal_url', { length: 1000 }),
  contractUrl: varchar('contract_url', { length: 1000 }),
  attachments: jsonb('attachments').$type<string[]>(), // string[]

  // Activity
  lastActivityDate: timestamp('last_activity_date'),
  daysInCurrentStage: integer('days_in_current_stage').default(0),
  totalActivities: integer('total_activities').default(0),

  // Custom Fields
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(), // Record<string, unknown>
  tags: jsonb('tags').$type<string[]>(), // string[]
}, (table) => [
  index('crm_opportunities_customer_idx').on(table.customerId),
  index('crm_opportunities_counterparty_idx').on(table.counterpartyId),
  index('crm_opportunities_primary_person_idx').on(table.primaryPersonId),
  index('crm_opportunities_stage_idx').on(table.stage),
  index('crm_opportunities_stage_id_idx').on(table.stageId),
  index('crm_opportunities_status_idx').on(table.status),
  index('crm_opportunities_owner_idx').on(table.ownerId),
  index('crm_opportunities_close_date_idx').on(table.closeDate),
  index('crm_opportunities_pipeline_idx').on(table.pipeline),
]);

export type CrmOpportunity = typeof crmOpportunities.$inferSelect;
export type NewCrmOpportunity = typeof crmOpportunities.$inferInsert;
