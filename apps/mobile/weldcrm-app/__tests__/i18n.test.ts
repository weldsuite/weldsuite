import { interpolate, plural } from '@/lib/i18n/interpolate';
import { deviceLanguage, resolveAppLanguage } from '@/lib/i18n/language';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import { labelFor } from '@/lib/i18n/provider';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leaves(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, String(value)]];
}

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe('resolveAppLanguage', () => {
  it('keeps English and Dutch, including regional tags', () => {
    expect(resolveAppLanguage('en')).toBe('en');
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('en_GB')).toBe('en');
  });

  it('falls back to English for unsupported or empty values', () => {
    expect(resolveAppLanguage('es')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
  });

  it('reads the phone locale', () => {
    expect(['en', 'nl']).toContain(deviceLanguage());
  });
});

describe('interpolate and plural', () => {
  it('substitutes named placeholders and leaves unknown ones', () => {
    expect(interpolate('{field} is required', { field: 'Name' })).toBe('Name is required');
    expect(interpolate('Hello {who}', {})).toBe('Hello {who}');
  });

  it('picks one or other and injects the count', () => {
    expect(plural(1, en.home.revenueExcluded)).toBe('1 won deal in another currency is not included');
    expect(plural(3, nl.home.revenueExcluded)).toContain('3 gewonnen deals');
  });
});

describe('labelFor', () => {
  it('uses the catalog label and falls back to the raw key', () => {
    expect(labelFor(en.status, 'active')).toBe('Active');
    expect(labelFor(en.status, 'on_hold')).toBe('on hold');
    expect(labelFor(en.status, undefined)).toBe('');
  });
});

describe('English and Dutch catalogs', () => {
  it('have the same keys so a locale switch cannot miss a string', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('use the same placeholders in both languages', () => {
    const dutch = new Map(leaves(nl));
    for (const [key, text] of leaves(en)) {
      expect({ key, placeholders: placeholders(dutch.get(key) ?? '') }).toEqual({
        key,
        placeholders: placeholders(text),
      });
    }
  });

  it('have no empty strings', () => {
    for (const [key, text] of [...leaves(en), ...leaves(nl)]) {
      expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false });
    }
  });

  it('translate the tab titles and a representative sample instead of copying English', () => {
    expect(nl.tabs.contacts).toBe('Contacten');
    expect(nl.tabs.tasks).toBe('Taken');
    expect(nl.tabs.more).toBe('Meer');
    expect(nl.validation.required).not.toBe(en.validation.required);
    expect(nl.tasks.deleteTask).not.toBe(en.tasks.deleteTask);
    expect(nl.contacts.people).not.toBe(en.contacts.people);
  });
});
