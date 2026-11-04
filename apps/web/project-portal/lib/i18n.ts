/**
 * The portal's languages and the small text helpers around its strings. The
 * strings themselves live in @weldsuite/i18n (`projectPortal.portal`, en and
 * nl); the server picks the reader's language and sends that one dictionary
 * with the page (lib/page-data.ts), so the browser never loads the other.
 */
import type { projectPortal } from '@weldsuite/i18n/locales/en/project-portal'

export type Locale = 'en' | 'nl'
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALES: readonly Locale[] = ['en', 'nl']

/** The cookie of @weldsuite/i18n's cookie adapter, so the choice is shared with the other apps' convention. */
export const LOCALE_COOKIE = 'locale'

export type PortalStrings = typeof projectPortal.portal

/** A string in the two plural forms en and nl have. */
export interface PluralForms {
  one: string
  other: string
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'nl'
}

function cookieLocale(cookieHeader: string | null): Locale | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key !== LOCALE_COOKIE) continue
    const decoded = decodeURIComponent(value.join('='))
    return isLocale(decoded) ? decoded : undefined
  }
  return undefined
}

function acceptedLocale(header: string | null): Locale | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const lang = part.split(';')[0]?.trim().toLowerCase().split('-')[0]
    if (isLocale(lang)) return lang
  }
  return undefined
}

/** The language of a request: the `locale` cookie, then Accept-Language, then English. */
export function localeFromRequest(cookieHeader: string | null, acceptLanguage: string | null): Locale {
  return cookieLocale(cookieHeader) ?? acceptedLocale(acceptLanguage) ?? DEFAULT_LOCALE
}

/** `{name}` placeholders replaced by values; an unknown placeholder stays as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

/** The plural form for `count` in `locale`, with `{count}` and any other placeholder filled in. */
export function pluralize(
  forms: PluralForms,
  count: number,
  locale: Locale,
  values: Record<string, string | number> = {},
): string {
  const rule = new Intl.PluralRules(locale).select(Math.abs(count))
  const template = rule === 'one' ? forms.one : forms.other
  return fill(template, { count, ...values })
}
