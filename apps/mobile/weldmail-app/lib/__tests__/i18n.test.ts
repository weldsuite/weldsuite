import { MAIL_STRINGS, resolveMailLanguage } from '@/lib/i18n';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe('resolveMailLanguage', () => {
  it('uses Dutch for any Dutch locale', () => {
    expect(resolveMailLanguage('nl')).toBe('nl');
    expect(resolveMailLanguage('nl-NL')).toBe('nl');
    expect(resolveMailLanguage('nl-BE')).toBe('nl');
  });

  it('falls back to English for everything else', () => {
    expect(resolveMailLanguage('en-GB')).toBe('en');
    expect(resolveMailLanguage('de-DE')).toBe('en');
    expect(resolveMailLanguage(undefined)).toBe('en');
  });
});

describe('English and Dutch strings', () => {
  it('have the same keys', () => {
    expect(leafKeys(MAIL_STRINGS.nl).sort()).toEqual(leafKeys(MAIL_STRINGS.en).sort());
  });

  it('are translated, not copied', () => {
    expect(MAIL_STRINGS.nl.compose.send).not.toBe(MAIL_STRINGS.en.compose.send);
    expect(MAIL_STRINGS.nl.compose.recipientRequired).not.toBe(MAIL_STRINGS.en.compose.recipientRequired);
  });
});
