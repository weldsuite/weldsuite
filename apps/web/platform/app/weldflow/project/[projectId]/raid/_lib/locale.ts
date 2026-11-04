import { localeConfig, type Language } from '@weldsuite/i18n/locales';

/** The `Intl` locale of the user's language ("nl" is "nl-NL"). */
export function intlLocaleOf(language: Language): string {
  return localeConfig[language]?.intlLocale ?? 'en-US';
}
