import { interpolate, plural } from '../interpolate';
import { deviceLocale, resolveAppLanguage } from '../language';
import { en } from '../locales/en';
import { nl } from '../locales/nl';

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leaves(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, String(value)]];
}

function leafKeys(value: unknown): string[] {
  return leaves(value).map(([key]) => key);
}

function placeholders(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).sort();
}

describe('resolveAppLanguage', () => {
  it('keeps English and Dutch and maps regional tags', () => {
    expect(resolveAppLanguage('en')).toBe('en');
    expect(resolveAppLanguage('nl')).toBe('nl');
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('nl_BE')).toBe('nl');
    expect(resolveAppLanguage('en-GB')).toBe('en');
  });

  it('falls back to English for anything else', () => {
    expect(resolveAppLanguage('de-DE')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
    expect(resolveAppLanguage('')).toBe('en');
  });

  it('reads a locale tag from the device', () => {
    expect(typeof deviceLocale()).toBe('string');
  });
});

describe('interpolate and plural', () => {
  it('substitutes named placeholders and keeps unknown ones', () => {
    expect(interpolate('{picked}/{total} lines', { picked: 2, total: 5 })).toBe('2/5 lines');
    expect(interpolate('Hello {name}')).toBe('Hello {name}');
  });

  it('picks one vs other', () => {
    expect(plural(1, { one: '{count} line', other: '{count} lines' })).toBe('1 line');
    expect(plural(3, { one: '{count} line', other: '{count} lines' })).toBe('3 lines');
  });
});

describe('English and Dutch catalogs', () => {
  it('have the same keys', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('use the same placeholders in every string', () => {
    const dutch = new Map(leaves(nl));
    for (const [key, text] of leaves(en)) {
      expect({ key, placeholders: placeholders(dutch.get(key) ?? '') }).toEqual({
        key,
        placeholders: placeholders(text),
      });
    }
  });

  it('translate the tab titles and the screen headings', () => {
    expect(nl.tabs.timeOff).not.toBe(en.tabs.timeOff);
    expect(nl.tabs.expenses).not.toBe(en.tabs.expenses);
    expect(nl.leaveForm.title).not.toBe(en.leaveForm.title);
    expect(nl.sick.title).not.toBe(en.sick.title);
    expect(nl.team.approvals).not.toBe(en.team.approvals);
  });

  it('name every status and category the API sends', () => {
    expect(Object.keys(en.leaveStatus).sort()).toEqual(['approved', 'cancelled', 'pending', 'rejected']);
    expect(Object.keys(en.declarationStatus).sort()).toEqual(['approved', 'cancelled', 'paid', 'pending', 'rejected']);
    expect(Object.keys(en.declarationCategory).sort()).toEqual(
      ['accommodation', 'equipment', 'meals', 'other', 'training', 'travel'],
    );
    expect(Object.keys(en.attendanceStatus).sort()).toEqual(['absent', 'excused', 'half_day', 'late', 'present', 'remote']);
  });
});
