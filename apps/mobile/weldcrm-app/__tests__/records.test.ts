import { customInputToValue, customValueToInput, formatCustomValue, mergeCustomValues } from '@/lib/custom-fields';
import { checkWebsite } from '@/lib/validation';
import { languageName, languageOptions, toHexColor } from '@/lib/field-options';
import { groupNotes } from '@/lib/note-groups';
import { formatAddress, mapAddress, type CustomFieldDefinition } from '@/services/api';
import { mapNote, recordLinkPayload, recordOfActivity } from '@/services/notes';
import { auditValue, mapAudit, mapCall } from '@/services/record-tabs';

const def = (fieldType: CustomFieldDefinition['fieldType'], options: CustomFieldDefinition['options'] = []): CustomFieldDefinition => ({
  id: 'f',
  slug: 'f',
  name: 'Field',
  fieldType,
  options,
  required: false,
});
const fmt = { locale: 'en-GB', yes: 'Yes', no: 'No', memberName: (id: string) => (id === 'u1' ? 'Gert' : undefined) };

describe('custom fields', () => {
  it('formats each type for display', () => {
    expect(formatCustomValue(def('boolean'), true, fmt)).toBe('Yes');
    expect(formatCustomValue(def('single_select', [{ label: 'Gold', value: 'gold' }]), 'gold', fmt)).toBe('Gold');
    expect(formatCustomValue(def('multi_select', [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]), ['a', 'b'], fmt)).toBe('A, B');
    expect(formatCustomValue(def('rating'), 3, fmt)).toBe('★★★');
    expect(formatCustomValue(def('user_ref'), 'u1', fmt)).toBe('Gert');
    expect(formatCustomValue(def('text'), '', fmt)).toBe('');
  });

  it('parses typed text back to values, rejecting nonsense', () => {
    expect(customInputToValue(def('number'), '12,5')).toBe(12.5);
    expect(customInputToValue(def('number'), 'abc')).toBeUndefined();
    expect(customInputToValue(def('date'), '2026-10-22')).toBe('2026-10-22');
    expect(customInputToValue(def('date'), '22/10/2026')).toBeUndefined();
    expect(customInputToValue(def('text'), '  ')).toBeNull();
    expect(customValueToInput(def('date'), '2026-10-22T00:00:00.000Z')).toBe('2026-10-22');
  });

  it('sends the whole map, dropping cleared values', () => {
    expect(mergeCustomValues({ a: 1, b: 'x', c: 'keep' }, { b: null, d: [] , e: 'new' })).toEqual({ a: 1, c: 'keep', e: 'new' });
  });
});

describe('field options', () => {
  it('names languages in the app language', () => {
    expect(languageName('nl', 'en')).toBe('Dutch');
    expect(languageName('de', 'nl')).toBe('Duits');
    expect(languageName('xx', 'en')).toBe('XX');
    expect(languageOptions('en')[0].label <= languageOptions('en')[1].label).toBe(true);
  });

  it('turns stored status colours into hex', () => {
    expect(toHexColor('blue')).toBe('#3B82F6');
    expect(toHexColor('bg-red-500')).toBe('#EF4444');
    expect(toHexColor('#123456')).toBe('#123456');
    expect(toHexColor('mauve')).toBeUndefined();
  });

  it('checks websites', () => {
    expect(checkWebsite('www.acme.nl')).toBeNull();
  });
});

describe('addresses', () => {
  it('reads both address shapes and formats them', () => {
    const address = mapAddress({ street: 'Main', houseNumber: '1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' });
    expect(address).toEqual({ line1: 'Main 1', line2: undefined, postalCode: '1234 AB', city: 'Utrecht', state: undefined, country: 'NL' });
    expect(formatAddress(address)).toBe('Main 1, 1234 AB Utrecht, NL');
    expect(mapAddress({})).toBeUndefined();
  });
});

describe('notes and activity links', () => {
  it('links a company or a person the way the platform does', () => {
    expect(recordLinkPayload({ kind: 'company', id: 'cmp_1', name: 'Acme' })).toEqual({
      relatedTo: 'company',
      relatedToId: 'cmp_1',
      relatedToName: 'Acme',
      customerId: 'cmp_1',
    });
    expect(recordLinkPayload({ kind: 'person', id: 'per_1' })).toEqual({
      relatedTo: 'person',
      relatedToId: 'per_1',
      contactId: 'per_1',
    });
    expect(recordLinkPayload(undefined)).toEqual({});
  });

  it('reads the record back, preferring the typed columns', () => {
    expect(recordOfActivity({ contactId: 'per_1', relatedToName: 'Jane' })).toEqual({ kind: 'person', id: 'per_1', name: 'Jane' });
    expect(recordOfActivity({ relatedTo: 'customer', relatedToId: 'cmp_9' })).toEqual({ kind: 'company', id: 'cmp_9', name: undefined });
    expect(recordOfActivity({})).toBeUndefined();
  });

  it('groups notes: pinned, today, yesterday, earlier', () => {
    const now = new Date(2026, 9, 22, 15);
    const note = (id: string, updatedAt: Date, isFavorite = false) =>
      mapNote({ id, subject: id, isFavorite, createdAt: updatedAt.toISOString(), updatedAt: updatedAt.toISOString() });
    const groups = groupNotes(
      [
        note('pin', new Date(2026, 0, 1), true),
        note('today', new Date(2026, 9, 22, 9)),
        note('yesterday', new Date(2026, 9, 21, 23)),
        note('old', new Date(2026, 9, 1)),
      ],
      now,
    );
    expect(groups.map((g) => [g.key, g.data.map((n) => n.id)])).toEqual([
      ['pinned', ['pin']],
      ['today', ['today']],
      ['yesterday', ['yesterday']],
      ['earlier', ['old']],
    ]);
  });
});

describe('record tabs', () => {
  it('shows the other party of a call', () => {
    expect(
      mapCall({ id: 'c1', direction: 'inbound', status: 'completed', fromNumber: '+31', toNumber: '+32', initiatedAt: 'x', duration: 65 }),
    ).toMatchObject({ number: '+31', duration: 65 });
    expect(
      mapCall({ id: 'c2', direction: 'outbound', status: 'completed', fromNumber: '+31', toNumber: '+32', toNumberFormatted: '+32 1', initiatedAt: 'x' }),
    ).toMatchObject({ number: '+32 1' });
  });

  it('lists audit changes as text', () => {
    expect(auditValue(null)).toBe('—');
    expect(auditValue(['a', 'b'])).toBe('a, b');
    expect(
      mapAudit({ id: 'a1', action: 'updated', changes: { status: { from: 'active', to: 'inactive' } }, createdAt: 'x' }).changes,
    ).toEqual([{ field: 'status', from: 'active', to: 'inactive' }]);
  });
});
