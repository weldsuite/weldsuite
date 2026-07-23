import { describe, it, expect } from 'vitest';
import { customFieldsToImportFields } from './to-import-fields';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

const def = (over: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: 'cf_1',
  entityType: 'company',
  name: 'Field',
  slug: 'field',
  fieldType: 'text',
  ...over,
});

describe('customFieldsToImportFields', () => {
  it('returns [] for undefined or empty input', () => {
    expect(customFieldsToImportFields(undefined)).toEqual([]);
    expect(customFieldsToImportFields([])).toEqual([]);
  });

  it('namespaces accessorKey with cf: and carries the slug', () => {
    const [f] = customFieldsToImportFields([def({ slug: 'vip', name: 'VIP customer' })]);
    expect(f).toMatchObject({
      header: 'VIP customer',
      accessorKey: 'cf:vip',
      customFieldSlug: 'vip',
    });
  });

  it('maps numeric field types to valueType number', () => {
    const fields = customFieldsToImportFields([
      def({ slug: 'a', fieldType: 'text' }),
      def({ slug: 'b', fieldType: 'number' }),
      def({ slug: 'c', fieldType: 'currency' }),
      def({ slug: 'd', fieldType: 'rating' }),
      def({ slug: 'e', fieldType: 'boolean' }),
      def({ slug: 'f', fieldType: 'date' }),
    ]);
    expect(fields.map((x) => x.valueType)).toEqual([
      'string',
      'number',
      'number',
      'number',
      'boolean',
      'string',
    ]);
  });

  it('marks multi_select as multiValue', () => {
    const [single] = customFieldsToImportFields([def({ slug: 's', fieldType: 'single_select' })]);
    const [multi] = customFieldsToImportFields([def({ slug: 'm', fieldType: 'multi_select' })]);
    expect(single.multiValue).toBeFalsy();
    expect(multi.multiValue).toBe(true);
  });

  it('skips file fields (not CSV-mappable)', () => {
    const fields = customFieldsToImportFields([
      def({ slug: 'doc', fieldType: 'file' }),
      def({ slug: 'ok', fieldType: 'text' }),
    ]);
    expect(fields.map((x) => x.customFieldSlug)).toEqual(['ok']);
  });
});
