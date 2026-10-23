import { MEET_STRINGS, resolveMeetLanguage } from '@/lib/i18n';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe('resolveMeetLanguage', () => {
  it('uses Dutch for any Dutch locale', () => {
    expect(resolveMeetLanguage('nl')).toBe('nl');
    expect(resolveMeetLanguage('nl-NL')).toBe('nl');
    expect(resolveMeetLanguage('nl-BE')).toBe('nl');
  });

  it('falls back to English for everything else', () => {
    expect(resolveMeetLanguage('en-GB')).toBe('en');
    expect(resolveMeetLanguage('de-DE')).toBe('en');
    expect(resolveMeetLanguage(undefined)).toBe('en');
  });
});

describe('English and Dutch strings', () => {
  it('have the same keys', () => {
    expect(leafKeys(MEET_STRINGS.nl).sort()).toEqual(leafKeys(MEET_STRINGS.en).sort());
  });

  it('are translated, not copied', () => {
    expect(MEET_STRINGS.nl.boot.failedTitle).not.toBe(MEET_STRINGS.en.boot.failedTitle);
    expect(MEET_STRINGS.nl.boot.retry).not.toBe(MEET_STRINGS.en.boot.retry);
  });
});
