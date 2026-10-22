/**
 * Run via: pnpm --filter platform exec vitest run ../../mobile/weldsocial-app/lib/__tests__/i18n.test.ts
 * (WeldSocial has no Jest setup; its unit tests run under the platform's vitest.)
 */
import { describe, expect, it } from 'vitest';
import { interpolate, plural } from '../i18n/interpolate';
import { resolveAppLanguage } from '../i18n/language';
import { en } from '../i18n/locales/en';
import { nl } from '../i18n/locales/nl';
import { POST_STATUS_VARIANT, statusBadge } from '../social';

const catalogs = { en, nl };

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function leafEntries(value: unknown, prefix = ''): [string, string][] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafEntries(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, String(value)]];
}

describe('resolveAppLanguage', () => {
  it('uses Dutch for any Dutch locale', () => {
    expect(resolveAppLanguage('nl')).toBe('nl');
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('nl_BE')).toBe('nl');
  });

  it('falls back to English for everything else', () => {
    expect(resolveAppLanguage('en-GB')).toBe('en');
    expect(resolveAppLanguage('de-DE')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
    expect(resolveAppLanguage(null)).toBe('en');
  });
});

describe('English and Dutch catalogs', () => {
  it('have the same keys', () => {
    expect(leafKeys(catalogs.nl).sort()).toEqual(leafKeys(catalogs.en).sort());
  });

  it('keep the same placeholders in every string', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    const nl = new Map(leafEntries(catalogs.nl));
    for (const [key, english] of leafEntries(catalogs.en)) {
      expect({ key, placeholders: placeholders(nl.get(key) ?? '') }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  it('have no empty strings', () => {
    for (const language of ['en', 'nl'] as const) {
      for (const [key, text] of leafEntries(catalogs[language])) {
        expect({ language, key, empty: text.trim() === '' }).toEqual({ language, key, empty: false });
      }
    }
  });

  it('translate the tab titles and the draft status', () => {
    expect(catalogs.nl.tabs.queue).not.toBe(catalogs.en.tabs.queue);
    expect(catalogs.nl.tabs.approvals).not.toBe(catalogs.en.tabs.approvals);
    expect(catalogs.nl.postStatus.draft).not.toBe(catalogs.en.postStatus.draft);
  });
});

describe('interpolate and plural', () => {
  it('fills placeholders and leaves unknown ones alone', () => {
    expect(interpolate('Hey, {name}', { name: 'Sam' })).toBe('Hey, Sam');
    expect(interpolate('Hey, {name}')).toBe('Hey, {name}');
  });

  it('picks the singular or plural form', () => {
    const forms = catalogs.en.accounts.imported;
    expect(plural(1, forms)).toBe('Imported 1 account');
    expect(plural(3, forms)).toBe('Imported 3 accounts');
  });
});

describe('statusBadge', () => {
  it('labels a draft instead of leaving the pill empty', () => {
    expect(statusBadge(POST_STATUS_VARIANT, catalogs.en.postStatus, 'draft')).toEqual({
      label: 'Draft',
      variant: 'secondary',
    });
    expect(statusBadge(POST_STATUS_VARIANT, catalogs.nl.postStatus, 'draft').label).toBe('Concept');
  });

  it('falls back to a readable raw status for an unknown one', () => {
    expect(statusBadge(POST_STATUS_VARIANT, catalogs.en.postStatus, 'on_hold')).toEqual({
      label: 'on hold',
      variant: 'outline',
    });
  });
});
