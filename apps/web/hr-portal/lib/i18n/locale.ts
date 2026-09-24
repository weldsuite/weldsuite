import type { Dictionary } from './en';
import { en } from './en';
import { nl } from './nl';

export type Locale = 'en' | 'nl';
export const LOCALES: Locale[] = ['en', 'nl'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'hrportal_locale';

export const dictionaries: Record<Locale, Dictionary> = { en, nl };

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'nl';
}

/** First supported locale in an `Accept-Language` header, else the default. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const tags = header.split(',').map((part) => part.split(';')[0]?.trim().toLowerCase());
  for (const tag of tags) {
    if (!tag) continue;
    const lang = tag.split('-')[0];
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}

/**
 * The browser's IANA time zone, stored so server-rendered times match what
 * the browser would show (the server itself runs in UTC). Until the cookie is
 * set — the very first visit — both sides render in UTC, then the page
 * refreshes once in the right zone (see TimeZoneSync in ./context.tsx).
 */
export const TIMEZONE_COOKIE = 'hrportal_tz';
export const DEFAULT_TIMEZONE = 'UTC';

export function isTimeZone(value: string | undefined | null): value is string {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
