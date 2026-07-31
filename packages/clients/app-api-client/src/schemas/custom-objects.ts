import { z } from 'zod';

// ============================================================================
// WeldObjects — user-defined custom objects.
//
// Two clearly separated surfaces, and the split matters for permissions:
//
//   DEFINITION  (/api/custom-objects/*)   — `weldobjects:manage`
//   DATA        (/api/objects/:slug/*)    — `weldobjects:<slug>:<action>`
//
// There is deliberately NO field CRUD here. A custom object's fields are
// ordinary custom_field_definitions rows, so the existing
// `/api/custom-fields?entityType=co_<slug>` surface already does the job —
// see schemas/custom-fields.ts. That reuse is the whole payoff of storing
// values in the existing EAV table.
//
// Backed by packages/core/db/src/schema/custom-objects.ts.
// ============================================================================

// ---------------------------------------------------------------------------
// Entity key
// ---------------------------------------------------------------------------

/**
 * Max slug length. This is a STORAGE constraint, not a style preference:
 * `search_index.entity_type` is varchar(30) and has to hold `co_` + slug.
 * Raising it means widening that column across every tenant database first.
 * Kept in lockstep with CUSTOM_OBJECT_SLUG_MAX_LENGTH in
 * @weldsuite/entity-events/custom-objects.
 */
export const CUSTOM_OBJECT_SLUG_MAX_LENGTH = 24;

export const customObjectSlugSchema = z
  .string()
  .min(1)
  .max(CUSTOM_OBJECT_SLUG_MAX_LENGTH)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Slug must start with a letter and contain only lowercase letters, numbers and underscores',
  );

/** Reserved slugs that would collide with built-in entity types or routes. */
export const RESERVED_OBJECT_SLUGS = [
  'company', 'companies', 'person', 'people', 'contact', 'contacts',
  'lead', 'leads', 'opportunity', 'opportunities', 'ticket', 'tickets',
  'conversation', 'conversations', 'project', 'projects', 'task', 'tasks',
  'product', 'products', 'order', 'orders', 'invoice', 'invoices',
  'user', 'users', 'settings', 'new', 'edit', 'create', 'admin', 'api',
] as const;

export const CUSTOM_OBJECT_STATUSES = ['draft', 'active', 'disabled'] as const;
export type CustomObjectStatus = (typeof CUSTOM_OBJECT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Object definitions
// ---------------------------------------------------------------------------

export const customObjectListConfigSchema = z.object({
  columns: z.array(z.string()).optional(),
  defaultSort: z
    .object({ key: z.string(), direction: z.enum(['asc', 'desc']) })
    .optional(),
});

export const createCustomObjectSchema = z.object({
  slug: customObjectSlugSchema.refine(
    (s) => !(RESERVED_OBJECT_SLUGS as readonly string[]).includes(s),
    { message: 'That name is reserved by a built-in WeldSuite object' },
  ),
  labelSingular: z.string().min(1).max(100),
  labelPlural: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().max(20).optional(),
  status: z.enum(CUSTOM_OBJECT_STATUSES).optional(),
  enableEvents: z.boolean().optional(),
  enableSearch: z.boolean().optional(),
  enableAgentTools: z.boolean().optional(),
  enableExternalApi: z.boolean().optional(),
  listConfig: customObjectListConfigSchema.optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * `slug` is absent by design — it is immutable after creation. Renaming would
 * orphan custom_field_values rows, grid_views rows, search_index rows and every
 * granted permission string, none of which can be fixed up transactionally
 * across a tenant. Same reasoning as `custom_field_definitions.entityType`.
 */
export const updateCustomObjectSchema = z.object({
  labelSingular: z.string().min(1).max(100).optional(),
  labelPlural: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  icon: z.string().max(50).optional(),
  color: z.string().max(20).nullish(),
  status: z.enum(CUSTOM_OBJECT_STATUSES).optional(),
  titleFieldId: z.string().max(30).nullish(),
  enableEvents: z.boolean().optional(),
  enableSearch: z.boolean().optional(),
  enableAgentTools: z.boolean().optional(),
  enableExternalApi: z.boolean().optional(),
  listConfig: customObjectListConfigSchema.optional(),
  sortOrder: z.number().int().optional(),
});

export const reorderCustomObjectsSchema = z.object({
  items: z.array(z.object({ id: z.string(), sortOrder: z.number().int() })),
});

export type CreateCustomObjectInput = z.infer<typeof createCustomObjectSchema>;
export type UpdateCustomObjectInput = z.infer<typeof updateCustomObjectSchema>;
export type ReorderCustomObjectsInput = z.infer<typeof reorderCustomObjectsSchema>;

// ---------------------------------------------------------------------------
// Links (relationship definitions)
// ---------------------------------------------------------------------------

export const CUSTOM_OBJECT_CARDINALITIES = [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
] as const;
export type CustomObjectCardinality = (typeof CUSTOM_OBJECT_CARDINALITIES)[number];

export const CUSTOM_OBJECT_ON_DELETE = ['restrict', 'cascade', 'set_null'] as const;
export type CustomObjectOnDelete = (typeof CUSTOM_OBJECT_ON_DELETE)[number];

/**
 * Built-in entity types a custom object may link to.
 *
 * An allow-list, not a free string: `targetEntityKey` drives a polymorphic
 * lookup, and letting a user point a link at an arbitrary table name would be
 * both a broken-reference generator and an information-disclosure surface.
 * Every entry here must have a resolver entry in
 * app-api/src/services/custom-object-targets.ts.
 */
export const LINKABLE_BUILTIN_ENTITY_TYPES = [
  'company',
  'person',
  'lead',
  'opportunity',
  'quote',
  'ticket',
  'conversation',
  'project',
  'task',
  'product',
  'order',
  'invoice',
] as const;
export type LinkableBuiltinEntityType = (typeof LINKABLE_BUILTIN_ENTITY_TYPES)[number];

/** Either a built-in entity type or a `co_<slug>` custom object key. */
export const linkTargetEntityKeySchema = z
  .string()
  .min(1)
  .max(30)
  .refine(
    (v) =>
      (LINKABLE_BUILTIN_ENTITY_TYPES as readonly string[]).includes(v) ||
      /^co_[a-z][a-z0-9_]*$/.test(v),
    { message: 'Target must be a supported built-in entity or a custom object key' },
  );

export const createCustomObjectLinkSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, 'Slug must be lowercase alphanumeric with underscores'),
  targetEntityKey: linkTargetEntityKeySchema,
  cardinality: z.enum(CUSTOM_OBJECT_CARDINALITIES),
  sourceLabel: z.string().min(1).max(100),
  targetLabel: z.string().min(1).max(100),
  onDelete: z.enum(CUSTOM_OBJECT_ON_DELETE).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** `slug`, `targetEntityKey` and `cardinality` are structural — immutable. */
export const updateCustomObjectLinkSchema = z.object({
  sourceLabel: z.string().min(1).max(100).optional(),
  targetLabel: z.string().min(1).max(100).optional(),
  onDelete: z.enum(CUSTOM_OBJECT_ON_DELETE).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateCustomObjectLinkInput = z.infer<typeof createCustomObjectLinkSchema>;
export type UpdateCustomObjectLinkInput = z.infer<typeof updateCustomObjectLinkSchema>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * `fields` is the `{ [slug]: value }` map the custom-fields layer already
 * speaks — the same shape companies and people use. Per-field type validation
 * happens server-side with `validateCustomFieldValue`, which needs each field's
 * definition and so cannot be expressed in this schema.
 */
export const createCustomObjectRecordSchema = z.object({
  fields: z.record(z.unknown()).optional(),
  ownerId: z.string().max(255).nullish(),
});

export const updateCustomObjectRecordSchema = z.object({
  fields: z.record(z.unknown()).optional(),
  ownerId: z.string().max(255).nullish(),
});

export const listCustomObjectRecordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  search: z.string().optional(),
  ownerId: z.string().optional(),
  /** `title`, `createdAt`, `updatedAt`, or `custom:<fieldSlug>`. */
  sort: z.string().optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  /** Repeatable `filter[custom:region]=EU` style params, flattened by the route. */
  filters: z.record(z.string()).optional(),
});

export type CreateCustomObjectRecordInput = z.infer<typeof createCustomObjectRecordSchema>;
export type UpdateCustomObjectRecordInput = z.infer<typeof updateCustomObjectRecordSchema>;

// ---------------------------------------------------------------------------
// Field types a custom object may use
// ---------------------------------------------------------------------------

/**
 * `entity_ref` is deliberately excluded. Relationships on custom objects go
 * through custom_object_links, which supports many-to-many and indexes the
 * reverse direction; `entity_ref` does neither. Offering both would be two
 * mechanisms for one concept. It remains available for custom fields on
 * built-in entities.
 */
export const CUSTOM_OBJECT_FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'boolean',
  'single_select', 'multi_select', 'url', 'email', 'phone',
  'currency', 'rating', 'file', 'user_ref',
] as const;
export type CustomObjectFieldType = (typeof CUSTOM_OBJECT_FIELD_TYPES)[number];

/** Field types eligible to be an object's title field. */
export const TITLE_ELIGIBLE_FIELD_TYPES = ['text', 'email', 'url', 'phone'] as const;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface CustomObjectSummary {
  id: string;
  slug: string;
  entityKey: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  icon: string;
  color: string | null;
  status: CustomObjectStatus;
  titleFieldId: string | null;
  enableEvents: boolean;
  enableSearch: boolean;
  enableAgentTools: boolean;
  enableExternalApi: boolean;
  sortOrder: number;
  /** Populated on list responses so the sidebar can show counts. */
  recordCount?: number;
  fieldCount?: number;
}

export interface CustomObjectRecordResponse {
  id: string;
  objectId: string;
  entityKey: string;
  title: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  /** Hydrated `{ [fieldSlug]: value }`. */
  fields: Record<string, unknown>;
}
