import { interpolate, plural } from '@/lib/i18n/interpolate';
import { resolveAppLanguage } from '@/lib/i18n/language';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe('resolveAppLanguage', () => {
  it('keeps English and Dutch as-is', () => {
    expect(resolveAppLanguage('en')).toBe('en');
    expect(resolveAppLanguage('nl')).toBe('nl');
  });

  it('maps regional tags onto the base language', () => {
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('en_GB')).toBe('en');
  });

  it('falls back to English for unsupported or empty profile values', () => {
    expect(resolveAppLanguage('es')).toBe('en');
    expect(resolveAppLanguage('fr-FR')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
    expect(resolveAppLanguage('')).toBe('en');
  });
});

describe('interpolate and plural', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('{count} remaining', { count: 12 })).toBe('12 remaining');
  });

  it('picks one vs other and injects the count', () => {
    expect(plural(1, { one: '{count} run', other: '{count} runs' })).toBe('1 run');
    expect(plural(3, { one: '{count} run', other: '{count} runs' })).toBe('3 runs');
  });
});

describe('English and Dutch catalogs', () => {
  it('expose the same keys so a locale switch cannot miss a string', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('actually translates a representative sample rather than copying English', () => {
    expect(nl.settings.language).toBe('Taal');
    expect(nl.auth.signIn).toBe('Inloggen');
    expect(nl.credits.balance).toBe('Saldo');
    expect(nl.credits.balance).not.toBe(en.credits.balance);
    expect(nl.chat.composerPlaceholder).not.toBe(en.chat.composerPlaceholder);
  });
});
