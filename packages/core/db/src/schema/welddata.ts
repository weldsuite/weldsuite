import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldData — lead-database (Lemlist-backed) module.
 *
 * Users search an external B2B lead database (people & companies) and save
 * the rows they like into WeldData lists. These are deliberately NOT WeldCRM
 * records: a saved lead is a snapshot of external data and only enters the
 * CRM `people` / `companies` tables when the user explicitly converts it.
 *
 * Tenant-scoped: like every other tenant table (see `lists.ts`, `people.ts`)
 * there is no `workspaceId` column — the tenant DB itself is the workspace
 * boundary.
 */

/**
 * welddata_lists — a named bucket of saved leads. Each list is typed to a
 * single `kind` ('person' | 'company'); a list never mixes the two, so its
 * leads, enrichment columns and conversions are all homogeneous.
 */
export const welddataLists = pgTable('welddata_lists', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  /** 'person' | 'company' — the only kind of lead this list accepts. */
  kind: varchar('kind', { length: 10 }).notNull().default('person'),

  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }),
  color: varchar('color', { length: 50 }).notNull().default('bg-blue-500'),
  icon: varchar('icon', { length: 100 }).notNull().default('Database'),

  /** Clerk user id of the creator. */
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('welddata_lists_name_idx').on(table.name),
  index('welddata_lists_deleted_at_idx').on(table.deletedAt),
]);

export type WelddataList = typeof welddataLists.$inferSelect;
export type NewWelddataList = typeof welddataLists.$inferInsert;

/**
 * welddata_leads — a single saved lead snapshot inside a list.
 *
 * `data` holds the full payload returned by the external database so nothing
 * is lost; the denormalized columns mirror the fields the grid renders and
 * searches on. Conversion linkage points at the CRM rows created when the
 * user converts the lead.
 */
export const welddataLeads = pgTable('welddata_leads', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  listId: varchar('list_id', { length: 30 }).notNull(),
  addedBy: varchar('added_by', { length: 255 }),

  /** 'person' | 'company' */
  kind: varchar('kind', { length: 10 }).notNull(),
  /** External database id for the row (used for dedupe within a list). */
  lemlistId: varchar('lemlist_id', { length: 255 }),

  /** Full external payload snapshot. */
  data: jsonb('data').$type<Record<string, unknown>>(),

  // Denormalized display / search columns
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  title: varchar('title', { length: 255 }),
  companyName: varchar('company_name', { length: 255 }),
  domain: varchar('domain', { length: 255 }),
  industry: varchar('industry', { length: 255 }),
  location: varchar('location', { length: 255 }),
  country: varchar('country', { length: 100 }),
  companySize: varchar('company_size', { length: 50 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),

  // Conversion linkage
  convertedStatus: varchar('converted_status', { length: 10 }).notNull().default('pending'), // 'pending' | 'converted'
  convertedAt: timestamp('converted_at'),
  convertedPersonId: varchar('converted_person_id', { length: 30 }),
  convertedCompanyId: varchar('converted_company_id', { length: 30 }),
}, (table) => [
  index('welddata_leads_list_idx').on(table.listId),
  index('welddata_leads_converted_status_idx').on(table.convertedStatus),
  index('welddata_leads_deleted_at_idx').on(table.deletedAt),
  uniqueIndex('welddata_leads_list_lemlist_unique').on(table.listId, table.kind, table.lemlistId),
]);

export type WelddataLead = typeof welddataLeads.$inferSelect;
export type NewWelddataLead = typeof welddataLeads.$inferInsert;

/**
 * welddata_columns — Clay-style enrichment columns on a list. Each column is a
 * pluggable "action" (`type` = action id, e.g. 'ai'; `config` = per-action
 * settings). Running a column produces one `welddata_cells` row per lead.
 *
 * The action machinery is registry-based (see apps/web/platform/trigger/welddata/
 * actions/): adding a provider (prospeo, hunter, …) is a new config schema +
 * handler + UI form — no change to this table or the run pipeline.
 */
export const welddataColumns = pgTable('welddata_columns', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  listId: varchar('list_id', { length: 30 }).notNull(),

  name: varchar('name', { length: 255 }).notNull(),
  /** Action id — denormalized from `config.type` for querying. */
  type: varchar('type', { length: 30 }).notNull().default('ai'),
  /** Per-action config (discriminated union, validated in the shared schema). */
  config: jsonb('config').$type<Record<string, unknown>>(),

  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('welddata_columns_list_idx').on(table.listId),
  index('welddata_columns_deleted_at_idx').on(table.deletedAt),
]);

export type WelddataColumn = typeof welddataColumns.$inferSelect;
export type NewWelddataColumn = typeof welddataColumns.$inferInsert;

/**
 * welddata_cells — the result of running a column's action against one lead.
 * One row per (columnId, leadId). `status` tracks the async run lifecycle.
 */
export const welddataCells = pgTable('welddata_cells', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  columnId: varchar('column_id', { length: 30 }).notNull(),
  leadId: varchar('lead_id', { length: 30 }).notNull(),

  /** 'pending' | 'running' | 'done' | 'error' */
  status: varchar('status', { length: 10 }).notNull().default('pending'),
  /** Primary text result rendered in the grid. */
  value: text('value'),
  /** Structured action output (provider payload, parsed fields, …). */
  data: jsonb('data').$type<Record<string, unknown>>(),
  error: text('error'),
  creditsUsed: integer('credits_used'),
  ranAt: timestamp('ran_at'),
}, (table) => [
  index('welddata_cells_column_idx').on(table.columnId),
  index('welddata_cells_lead_idx').on(table.leadId),
  uniqueIndex('welddata_cells_column_lead_unique').on(table.columnId, table.leadId),
]);

export type WelddataCell = typeof welddataCells.$inferSelect;
export type NewWelddataCell = typeof welddataCells.$inferInsert;
