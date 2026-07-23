/**
 * Convert `CustomFieldDefinition`s from the settings API into importer field
 * defs, so any user-defined custom field can be mapped from a CSV/Excel column
 * during a CRM import (companies / people).
 *
 * Values are written under `record.customFields[slug]` (the same slug-keyed
 * JSONB layout the grid + edit forms use) and coerced per field type:
 * number/currency/rating -> number, boolean -> boolean, multi_select -> string[],
 * everything else stays a string. The `file` type is skipped (not CSV-mappable).
 */

import type { ImportFieldDef } from '@/app/weldcrm/components/import-entities-dialog';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

function valueTypeFor(fieldType: string): 'string' | 'number' | 'boolean' {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'rating':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

export function customFieldsToImportFields(
  defs: CustomFieldDefinition[] | undefined,
): ImportFieldDef[] {
  if (!defs || defs.length === 0) return [];
  return defs
    .filter((def) => def.fieldType !== 'file')
    .map((def) => ({
      header: def.name,
      // Namespaced so it can never collide with a built-in field's accessorKey.
      accessorKey: `cf:${def.slug}`,
      customFieldSlug: def.slug,
      multiValue: def.fieldType === 'multi_select',
      valueType: valueTypeFor(def.fieldType),
    }));
}
