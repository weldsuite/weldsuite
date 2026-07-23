import { z } from 'zod';

// ============================================================================
// Custom Field Definitions — org-wide custom field definitions attached to a
// platform entity type (contact, customer, ticket, ...). Each definition is a
// reusable column; the parent `entityType` is immutable after creation.
//
// Backed by the `custom_field_definitions` table
// (packages/db/src/schema/custom-field-definitions).
// Permission prefix: `settings:*` (these are org-level settings objects).
// ============================================================================

export const FIELD_TYPES = [
  'text', 'number', 'date', 'single_select', 'multi_select',
  'boolean', 'url', 'email', 'phone', 'currency',
  'textarea', 'rating', 'file', 'user_ref', 'entity_ref',
] as const;

export const selectOptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  color: z.string().optional(),
});

export const createCustomFieldSchema = z.object({
  entityType: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'Slug must be lowercase alphanumeric with underscores'),
  description: z.string().max(500).optional(),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(selectOptionSchema).optional(),
  config: z.record(z.unknown()).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  group: z.string().max(100).optional(),
  /**
   * Scopes a definition to one `helpdesk_ticket_types` row (entityType
   * 'ticket'). Omitted / null = a global definition applying to all rows of the
   * entity type. A slug may repeat across ticket types but never within one, nor
   * twice globally — enforced by the two partial unique indexes on
   * `custom_field_definitions`.
   */
  ticketTypeId: z.string().max(30).nullish(),
});

// The parent entity type cannot be reassigned — omit it from updates.
export const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  fieldType: z.enum(FIELD_TYPES).optional(),
  options: z.array(selectOptionSchema).optional(),
  config: z.record(z.unknown()).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  group: z.string().max(100).optional(),
});

export const reorderCustomFieldsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      sortOrder: z.number().int(),
    }),
  ),
});

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type ReorderCustomFieldsInput = z.infer<typeof reorderCustomFieldsSchema>;

// ============================================================================
// Custom Field VALUES — the typed value store (custom_field_values table).
//
// A value is submitted as a map keyed by the field slug (the shape the UI and
// entity APIs already speak), e.g. `{ region: 'EU', priority: 3 }`. A `null`
// entry clears the value. Per-field type validation is done with
// `validateCustomFieldValue` against the field's definition, since the loose
// map schema below can't know each field's `fieldType`.
// ============================================================================

/** A single raw custom field value as it arrives over the wire. */
export const customFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.unknown()),
  z.null(),
]);

/** `{ [slug]: value }` — the patch used by entity create/update routes. */
export const setCustomFieldValuesSchema = z.record(customFieldValueSchema);

export type CustomFieldValueInput = z.infer<typeof customFieldValueSchema>;
export type SetCustomFieldValuesInput = z.infer<typeof setCustomFieldValuesSchema>;

/** Which typed value column a field type maps to in `custom_field_values`. */
export type CustomFieldValueColumn = 'text' | 'number' | 'date' | 'bool' | 'json' | 'ref';

export function fieldTypeToValueColumn(fieldType: (typeof FIELD_TYPES)[number]): CustomFieldValueColumn {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'rating':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'bool';
    case 'multi_select':
    case 'file':
      return 'json';
    case 'user_ref':
    case 'entity_ref':
      return 'ref';
    case 'text':
    case 'textarea':
    case 'url':
    case 'email':
    case 'phone':
    case 'single_select':
    default:
      return 'text';
  }
}

/** The minimal definition shape needed to validate/coerce a value. */
export interface CustomFieldDefinitionLike {
  slug: string;
  fieldType: (typeof FIELD_TYPES)[number];
  options?: { label: string; value: string; color?: string }[] | null;
  required?: boolean | null;
}

export interface CustomFieldValidationResult {
  ok: boolean;
  /** Coerced value ready to store (in the column implied by fieldType). Absent on error. */
  value?: string | number | boolean | string[] | Record<string, unknown> | null;
  error?: string;
}

/**
 * Validate + coerce a single raw value against its definition. Returns the
 * normalized value (or `null` to clear). Pure — safe to share client + server.
 */
export function validateCustomFieldValue(
  def: CustomFieldDefinitionLike,
  raw: unknown,
): CustomFieldValidationResult {
  const isEmpty = raw === null || raw === undefined || raw === '';
  if (isEmpty) {
    if (def.required) return { ok: false, error: `'${def.slug}' is required` };
    return { ok: true, value: null };
  }

  const optionValues = new Set((def.options ?? []).map((o) => o.value));

  switch (def.fieldType) {
    case 'number':
    case 'currency':
    case 'rating': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(n)) return { ok: false, error: `'${def.slug}' must be a number` };
      return { ok: true, value: n };
    }
    case 'boolean':
      return { ok: true, value: Boolean(raw) };
    case 'date': {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) return { ok: false, error: `'${def.slug}' must be a valid date` };
      return { ok: true, value: d.toISOString() };
    }
    case 'single_select': {
      const v = String(raw);
      if (optionValues.size > 0 && !optionValues.has(v)) {
        return { ok: false, error: `'${v}' is not a valid option for '${def.slug}'` };
      }
      return { ok: true, value: v };
    }
    case 'multi_select': {
      const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      if (optionValues.size > 0) {
        const bad = arr.find((v) => !optionValues.has(v));
        if (bad) return { ok: false, error: `'${bad}' is not a valid option for '${def.slug}'` };
      }
      return { ok: true, value: arr };
    }
    case 'file':
      return { ok: true, value: raw as Record<string, unknown> };
    case 'user_ref':
    case 'entity_ref':
      return { ok: true, value: String(raw) };
    case 'text':
    case 'textarea':
    case 'url':
    case 'email':
    case 'phone':
    default:
      return { ok: true, value: String(raw) };
  }
}
