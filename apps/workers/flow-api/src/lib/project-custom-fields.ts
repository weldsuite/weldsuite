/**
 * Project custom fields (Settings › Custom Fields › Projects).
 *
 * Unlike tasks, `projects` has no `custom_fields` blob column: the values live
 * only in the typed `custom_field_values` table (DATA-012, which is retiring the
 * blobs). That makes the write authoritative rather than a best-effort mirror,
 * so values are validated up front and a bad one is a 400 instead of being
 * dropped silently.
 */

import {
  assertValidCustomFieldValues,
  getDefinitionsForEntityType,
  setValues,
  type CustomFieldDefinitionRow,
  type CustomFieldMap,
} from '@weldsuite/core-domain/custom-field-values';
import type { Database } from '@weldsuite/worker-kit/db';

export const PROJECT_CUSTOM_FIELD_ENTITY = 'project';

export interface PreparedProjectCustomFields {
  values: CustomFieldMap;
  definitions: CustomFieldDefinitionRow[];
}

/**
 * Validate a request's `customFields` before the project row is written.
 * `undefined` means the request does not touch custom fields (returns null);
 * `null` clears them all. Throws `CustomFieldValidationError` on a bad value.
 */
export async function prepareProjectCustomFields(
  db: Database,
  customFields: CustomFieldMap | null | undefined,
): Promise<PreparedProjectCustomFields | null> {
  if (customFields === undefined) return null;
  const definitions = await getDefinitionsForEntityType(db, PROJECT_CUSTOM_FIELD_ENTITY);
  const values = customFields ?? {};
  assertValidCustomFieldValues(definitions, values);
  return { values, definitions };
}

/** Store the full set: a field left out of `values` is cleared. */
export async function writeProjectCustomFields(
  db: Database,
  projectId: string,
  prepared: PreparedProjectCustomFields,
): Promise<void> {
  await setValues(db, PROJECT_CUSTOM_FIELD_ENTITY, projectId, prepared.values, {
    definitions: prepared.definitions,
    patch: false,
    // Required fields are a UI prompt, not a write gate: a project created
    // from a dialog that does not show custom fields must still save.
    enforceRequired: false,
  });
}
