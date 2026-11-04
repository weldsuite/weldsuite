import { z } from 'zod';

// ============================================================================
// WeldData (data-api) response shapes: the lead database, lists, saved leads,
// enrichment columns and cells (the interfaces in `./welddata.ts`), the
// enrich field definitions and the enrichment views. The conformance suite
// validates both backends' answers against them. Zod v3.
// ============================================================================

const timestamp = z.string();
const kind = z.enum(['person', 'company']);

export const lemlistFilterDefinitionSchema = z.object({
  filterId: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'range', 'boolean', 'select', 'multiselect']),
  description: z.string().optional(),
  helper: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
});

export const lemlistFilterCatalogSchema = z.object({
  people: z.array(lemlistFilterDefinitionSchema),
  companies: z.array(lemlistFilterDefinitionSchema),
});

const optionalText = z.string().nullable();

export const lemlistSearchRowSchema = z.object({
  id: z.string(),
  kind,
  name: optionalText,
  email: optionalText,
  title: optionalText,
  companyName: optionalText,
  domain: optionalText,
  industry: optionalText,
  location: optionalText,
  country: optionalText,
  companySize: optionalText,
  linkedinUrl: optionalText,
  avatarUrl: optionalText,
  raw: z.record(z.unknown()),
});

export const lemlistSearchResultSchema = z.object({
  rows: z.array(lemlistSearchRowSchema),
  page: z.number().int(),
  size: z.number().int(),
  total: z.number(),
  hasMore: z.boolean(),
});

export const welddataListSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  kind,
  name: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  icon: z.string(),
  createdBy: z.string().nullable(),
});

export const welddataListWithCountSchema = welddataListSchema.extend({ leadCount: z.number().int() });

export const welddataLeadSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  listId: z.string(),
  addedBy: z.string().nullable(),
  kind,
  lemlistId: z.string().nullable(),
  data: z.record(z.unknown()).nullable(),
  name: optionalText,
  email: optionalText,
  title: optionalText,
  companyName: optionalText,
  domain: optionalText,
  industry: optionalText,
  location: optionalText,
  country: optionalText,
  companySize: optionalText,
  linkedinUrl: optionalText,
  convertedStatus: z.enum(['pending', 'converted']),
  convertedAt: timestamp.nullable(),
  convertedPersonId: z.string().nullable(),
  convertedCompanyId: z.string().nullable(),
});

export const welddataAddLeadsResultSchema = z.object({ added: z.number().int(), skipped: z.number().int() });

export const welddataConvertLeadResultSchema = z.object({
  leadId: z.string(),
  personId: z.string().nullable(),
  companyId: z.string().nullable(),
});

export const welddataConvertSearchLeadsResultSchema = z.object({
  converted: z.number().int(),
  people: z.number().int(),
  companies: z.number().int(),
});

export const welddataConvertToCrmListResultSchema = z.object({
  converted: z.number().int(),
  added: z.number().int(),
});

export const welddataColumnSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  listId: z.string(),
  name: z.string(),
  type: z.enum(['ai', 'email_finder', 'phone_finder']),
  config: z.record(z.unknown()),
  sortOrder: z.number().int(),
  createdBy: z.string().nullable(),
});

export const welddataCellSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  columnId: z.string(),
  leadId: z.string(),
  status: z.enum(['pending', 'running', 'done', 'error']),
  value: z.string().nullable(),
  data: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  creditsUsed: z.number().nullable(),
  ranAt: timestamp.nullable(),
});

export const welddataQueuedSchema = z.object({ queued: z.number().int() });

// ── enrich field definitions and the enrichment views ──────────────────────

export const enrichFieldDefinitionSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  provider: z.string(),
  operation: z.string(),
  entityType: z.string(),
  name: z.string(),
  slug: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  config: z.record(z.unknown()).nullable(),
});

export const enrichFieldsReorderedSchema = z.object({ reordered: z.number().int() });
export const enrichFieldDeletedSchema = z.object({ deleted: z.literal(true) });

export const enrichFieldResultSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  enrichFieldId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  provider: z.string(),
  operation: z.string(),
  status: z.string(),
  resultData: z.record(z.unknown()).nullable(),
  enrichmentLogId: z.string().nullable(),
});

export const enrichmentLogSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  provider: z.string(),
  operation: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
  requestParams: z.record(z.unknown()).nullable(),
  responseData: z.record(z.unknown()).nullable(),
  status: z.string(),
  errorMessage: z.string().nullable(),
  creditsUsed: z.number().int().nullable(),
  triggerTaskId: z.string().nullable(),
});
