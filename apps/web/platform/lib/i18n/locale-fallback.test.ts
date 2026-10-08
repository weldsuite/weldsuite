import { describe, expect, it } from 'vitest';
import { loadLocale, withEnglishFallback } from '@weldsuite/i18n/locales';
import { en } from '@weldsuite/i18n/locales/en';

describe('locale fallback', () => {
  it('fills keys a locale lacks from English, at any depth, keeping its own', () => {
    const merged = withEnglishFallback(
      { common: { actions: { cancel: 'Annuler' } } },
      { common: { actions: { cancel: 'Cancel', save: 'Save' } }, other: { title: 'Other' } },
    );
    expect(merged).toEqual({ common: { actions: { cancel: 'Annuler', save: 'Save' } }, other: { title: 'Other' } });
  });

  // Loads the fr and es bundles (dynamic imports); slow when the whole suite runs in parallel.
  it('gives partial locales every namespace English has', { timeout: 30_000 }, async () => {
    for (const locale of ['es', 'fr'] as const) {
      const bundle = await loadLocale(locale);
      expect(bundle.weldbooksUs.banking).toBeDefined();
      expect(Object.keys(bundle).sort()).toEqual(Object.keys(en).sort());
    }
  });
});
