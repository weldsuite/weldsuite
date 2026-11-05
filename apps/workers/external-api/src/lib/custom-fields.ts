/**
 * Custom fields on the CRM's `/v1` objects (companies, people).
 *
 * WeldCRM reads custom fields from the typed `custom_field_values` table
 * (`@weldsuite/db/lib/custom-field-values`), not from the row's
 * `customFields` blob. A create or update therefore checks every value against
 * the workspace's definitions before it writes anything, then writes the blob
 * and the typed values both, so one request carries the whole record.
 *
 * Keys without a definition are not refused: they stay in the blob, as they
 * always did, and the API keeps returning them; WeldCRM shows nothing for
 * them. `GET /v1/<object>/custom-fields` lists the slugs a workspace has.
 */

import type { Context } from 'hono';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  setValues,
  type CustomFieldDefinitionRow,
  type CustomFieldMap,
} from '@weldsuite/db/lib/custom-field-values';
import {
  validateCustomFieldValue,
  type CustomFieldDefinitionLike,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import { schema, type Database } from '../db';
import { generateId } from './id';
import { error } from './response';

/** The CRM objects whose `/v1` routes take custom fields. */
export type CrmCustomFieldEntity = 'company' | 'person';

/** `null` and `''` clear a field; they never fail validation. */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Code-unit order, as Rust's `str` order compares the same ASCII slugs. */
function bySlug(a: CustomFieldDefinitionRow, b: CustomFieldDefinitionRow): number {
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
}

/**
 * The values in `values` that their definition refuses, keyed by slug, in
 * slug order. An empty value clears the field and always passes; a required
 * field is not enforced (the platform's own writes don't either). Keys
 * without a definition pass.
 */
export function customFieldProblems(
  definitions: CustomFieldDefinitionRow[],
  values: CustomFieldMap,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const sorted = [...definitions].sort(bySlug);
  for (const def of sorted) {
    if (!Object.hasOwn(values, def.slug) || isEmptyValue(values[def.slug])) continue;
    const result = validateCustomFieldValue(def as CustomFieldDefinitionLike, values[def.slug]);
    if (!result.ok) problems[def.slug] = result.error ?? `Invalid value for '${def.slug}'`;
  }
  return problems;
}

/** The 400 for {@link customFieldProblems}: every refused value at once. */
export function customFieldsRefused(c: Context, problems: Record<string, string>) {
  return error.badRequest(c, `Invalid custom field values: ${Object.values(problems).join('; ')}`, {
    field: 'customFields',
    errors: problems,
  });
}

/**
 * An update's `customFields` merged into the stored blob: a sent key replaces
 * the stored one, an empty value (`null`, `''`) removes it, an unsent key is
 * kept.
 */
export function mergeCustomFields(stored: unknown, sent: CustomFieldMap): CustomFieldMap {
  const merged: CustomFieldMap = {
    ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as CustomFieldMap) : {}),
  };
  for (const [slug, value] of Object.entries(sent)) {
    if (isEmptyValue(value)) delete merged[slug];
    else merged[slug] = value;
  }
  return merged;
}

/**
 * Write the sent values to `custom_field_values`: only the slugs sent, an
 * empty value clearing its field. Call it after {@link customFieldProblems}
 * found nothing, so no value is refused here.
 */
export async function writeCustomFields(
  db: Database,
  entityType: CrmCustomFieldEntity,
  entityId: string,
  values: CustomFieldMap | undefined,
  definitions: CustomFieldDefinitionRow[],
): Promise<void> {
  if (!values || definitions.length === 0) return;
  await setValues(db, entityType, entityId, values, {
    generateId,
    definitions,
    patch: true,
    enforceRequired: false,
  });
}

/** `GET /v1/<object>/custom-fields`: the live definitions, in display order. */
export function listCustomFieldDefinitions(db: Database, entityType: CrmCustomFieldEntity) {
  const defs = schema.customFieldDefinitions;
  return db
    .select({
      id: defs.id,
      slug: defs.slug,
      name: defs.name,
      description: defs.description,
      fieldType: defs.fieldType,
      options: defs.options,
      config: defs.config,
      required: defs.required,
      group: defs.group,
      sortOrder: defs.sortOrder,
    })
    .from(defs)
    .where(and(eq(defs.entityType, entityType), isNull(defs.deletedAt)))
    .orderBy(asc(defs.sortOrder), asc(defs.name), asc(defs.id));
}
