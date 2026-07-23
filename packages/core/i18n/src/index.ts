import type { TranslationNamespaces, TranslationPath } from './types';
import {
  defaultLanguage,
  getLoadedTranslations,
  isLocaleLoaded,
  languages,
  loadLocale,
  localeConfig,
  type Language,
} from './locales';
import { cookieAdapter } from './adapters/cookie';

export type Locale = Language;
export type { LocaleAdapter } from './adapter';

/**
 * Get the current user's locale from the default web cookie adapter.
 * Returns the default language on SSR / non-DOM runtimes — consumers that
 * need server-side locale resolution should use `createHeaderAdapter` plus
 * an `I18nProvider`, not this function.
 */
export function getLocale(): Locale {
  return cookieAdapter.read?.() ?? defaultLanguage;
}

/**
 * Set the user's locale preference via the default web cookie adapter.
 * No-op on SSR / non-DOM runtimes. Also kicks off the lazy load of the
 * new locale's bundle so a subsequent re-render finds it ready.
 */
export function setLocale(locale: Locale) {
  cookieAdapter.write(locale);
  if (!isLocaleLoaded(locale)) {
    void loadLocale(locale);
  }
}

/**
 * Type-safe translation loader. Reads from the in-memory translations
 * cache populated by `<I18nProvider>` / `loadLocale()`. If the current
 * locale hasn't finished loading yet, falls back to the default (`en`)
 * bundle so the call still returns a usable shape.
 */
export function getTranslations<T extends keyof TranslationNamespaces>(
  namespace: T
): TranslationNamespaces[T] {
  const locale = getLocale();
  const allTranslations = getLoadedTranslations(locale);

  // Type assertion needed because TypeScript can't infer the dynamic key access
  return allTranslations[namespace as keyof typeof allTranslations] as TranslationNamespaces[T];
}

/**
 * Get all translations for a locale (whichever bundle is currently loaded;
 * falls back to `en` if the requested locale hasn't been loaded yet).
 */
export function getAllTranslations(): Record<string, any> {
  const locale = getLocale();
  return getLoadedTranslations(locale);
}

/**
 * Type-safe translator function creator
 */
export function createTranslator<T extends Record<string, any>>(translations: T) {
  return function t(key: string, params?: Record<string, any>): string {
    const keys = key.split('.');
    let value: any = translations;

    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        console.warn(`Translation key not found: ${key}`);
        return key;
      }
    }

    if (typeof value === 'function' && params) {
      return value(params);
    }

    if (typeof value === 'string') {
      if (params) {
        return Object.entries(params).reduce((str, [k, v]) =>
          str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
          value
        );
      }
      return value;
    }

    console.warn(`Translation value is not a string for key: ${key}`);
    return key;
  };
}

/**
 * Get nested translation value with type safety
 */
export function getNestedTranslation<T extends Record<string, any>>(
  translations: T,
  path: string
): string {
  const keys = path.split('.');
  let value: any = translations;

  for (const key of keys) {
    value = value?.[key];
    if (value === undefined) {
      return path;
    }
  }

  return typeof value === 'string' ? value : path;
}

/**
 * Get the Intl locale string for the current locale
 */
function getIntlLocale(): string {
  const locale = getLocale();
  return localeConfig[locale].intlLocale;
}

/**
 * Format number based on locale
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getIntlLocale(), options).format(value);
}

/**
 * Format currency based on locale
 */
export function formatCurrency(value: number, currency: string = 'EUR'): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    style: 'currency',
    currency
  }).format(value);
}

/**
 * Format date based on locale
 */
export function formatDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(getIntlLocale(), options).format(dateObj);
}

/**
 * Export all functions and types
 */
export type { TranslationNamespaces, TranslationPath } from './types';
