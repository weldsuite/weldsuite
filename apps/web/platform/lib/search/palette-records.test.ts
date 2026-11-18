import { describe, expect, it } from 'vitest';
import { SEARCH_ENTITY_TYPES, type SearchResultGroup } from '@weldsuite/app-api-client/schemas/search';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { paletteRecordGroups, paletteRecordTarget } from './palette-records';
import { RESULT_TYPE_ICON, resultTypeLabel } from './result-types';

function group(type: SearchResultGroup['type'], count: number): SearchResultGroup {
  return {
    type,
    items: Array.from({ length: count }, (_, i) => ({
      id: `${type}_${i}`,
      type,
      title: `${type} ${i}`,
      url: `/x/${type}_${i}`,
    })),
    totalCount: count,
    hasMore: false,
  };
}

describe('paletteRecordGroups', () => {
  it('keeps the API order, cuts each type to three rows and drops empty types', () => {
    const groups = paletteRecordGroups([group('customer', 5), group('invoice', 0), group('document', 2), group('form', 1)]);
    expect(groups.map((g) => g.type)).toEqual(['customer', 'document', 'form']);
    expect(groups.map((g) => g.items.length)).toEqual([3, 2, 1]);
  });

  it('lists a type once', () => {
    expect(paletteRecordGroups([group('task', 1), group('task', 2)])).toHaveLength(1);
  });

  it('handles no response', () => {
    expect(paletteRecordGroups(undefined)).toEqual([]);
  });
});

describe('paletteRecordTarget', () => {
  it('opens CRM companies and people in their panel, deep-linked from the list page', () => {
    expect(paletteRecordTarget({ id: 'cus 1', type: 'customer', url: '/weldcrm/customers/cus 1' })).toEqual({
      kind: 'panel',
      panel: { type: 'company', id: 'cus 1' },
      href: '/weldcrm/companies?stack=company:cus%201',
    });
    expect(paletteRecordTarget({ id: 'con_1', type: 'contact', url: '/weldcrm/contacts/con_1' })).toMatchObject({
      kind: 'panel',
      panel: { type: 'person', id: 'con_1' },
      href: '/weldcrm/people?stack=person:con_1',
    });
  });

  it('opens types with an entity sheet in the sheet', () => {
    expect(paletteRecordTarget({ id: 'tkt_1', type: 'ticket', url: '/welddesk/inbox?entity=ticket:tkt_1' })).toEqual({
      kind: 'sheet',
      type: 'ticket',
      id: 'tkt_1',
      href: '/welddesk/inbox?entity=ticket:tkt_1',
    });
  });

  it('opens every other type on its page', () => {
    expect(paletteRecordTarget({ id: 'doc_1', type: 'document', url: '/welddocs/doc_1' })).toEqual({
      kind: 'page',
      href: '/welddocs/doc_1',
    });
    expect(paletteRecordTarget({ id: 'frm_1', type: 'form', url: '/weldforms/frm_1' })).toEqual({
      kind: 'page',
      href: '/weldforms/frm_1',
    });
  });
});

describe('record type labels', () => {
  it.each(SEARCH_ENTITY_TYPES)('names and draws %s in English and Dutch', (type) => {
    expect(resultTypeLabel(en, type)).not.toBe(type);
    expect(resultTypeLabel(nl, type)).not.toBe(type);
    expect(RESULT_TYPE_ICON[type]).toBeTruthy();
  });

  it('calls CRM companies and people by their UI names', () => {
    expect(resultTypeLabel(en, 'customer')).toBe('Companies');
    expect(resultTypeLabel(nl, 'contact')).toBe('Personen');
  });

  it('falls back to the type for one this build does not know', () => {
    expect(resultTypeLabel(en, 'hologram')).toBe('hologram');
  });
});
