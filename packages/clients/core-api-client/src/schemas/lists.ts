import { z } from 'zod';

// ============================================================================
// Lists — `/api/weldcrm/lists` (new) and `/api/lists` (legacy compat).
//
// After the Companies + People refactor, each list is strictly per-entity-
// type: a `kind = 'company'` list holds only Companies, a `kind = 'person'`
// list holds only People. Mixed lists are not supported by design — every
// downstream operation (filter, bulk action, export, smart-list rules) is
// type-specific, so the constraint is enforced at create-time rather than
// branched on per row.
//
// The legacy `customer_lists` shape is still exported for routes that
// haven't been migrated yet.
// ============================================================================

// ----------------------------------------------------------------------------
// V2 — new shape (kind-discriminated, single members table)
// ----------------------------------------------------------------------------

export const listKind = z.enum(['company', 'person']);
export const listType = z.enum(['static', 'smart']);

export const createListSchemaV2 = z.object({
  name: z.string().min(1).max(255),
  /** Immutable after create. Determines which identity table members target. */
  kind: listKind,
  type: listType.default('static'),
  color: z.string().max(50).default('bg-blue-500'),
  icon: z.string().max(100).default('List'),
  description: z.string().max(1000).optional(),
  filterRules: z.record(z.unknown()).optional(),
});

export const updateListSchemaV2 = createListSchemaV2
  .omit({ kind: true })
  .partial();

export const listListsQueryV2 = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
  search: z.string().optional(),
  kind: listKind.optional(),
});

export const addListMembersSchemaV2 = z.object({
  entityIds: z.array(z.string()).min(1),
});

export type ListKind = z.infer<typeof listKind>;
export type ListType = z.infer<typeof listType>;
export type CreateListInput = z.infer<typeof createListSchemaV2>;
export type UpdateListInput = z.infer<typeof updateListSchemaV2>;
export type ListListsQueryV2 = z.infer<typeof listListsQueryV2>;
export type AddListMembersInputV2 = z.infer<typeof addListMembersSchemaV2>;

export interface ListEntity {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  icon: string;
  kind: ListKind;
  type: ListType;
  filterRules?: Record<string, unknown> | null;
  linkedListId?: string | null;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ListMember {
  id: string;
  listId: string;
  entityId: string;
  addedAt: string;
  addedBy?: string | null;
}

// ----------------------------------------------------------------------------
// Legacy — kept for compat shims in app-api routes that still read the old
// `customer_lists` shape via `/api/lists`. Drop once those routes migrate.
// ----------------------------------------------------------------------------

export const createListSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().max(50).default('bg-blue-500'),
  icon: z.string().max(100).default('Building2'),
  description: z.string().max(1000).optional(),
});

export const updateListSchema = createListSchema.partial();

export const listListsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
  search: z.string().optional(),
});

export const addListMembersSchema = z.object({
  customerIds: z.array(z.string()).optional(),
  contactIds: z.array(z.string()).optional(),
});

export type ListListsQuery = z.infer<typeof listListsQuery>;
export type AddListMembersInput = z.infer<typeof addListMembersSchema>;

export interface ListRow {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string | null;
  customerCount?: number;
  contactCount?: number;
  createdAt: string;
  updatedAt: string;
}
