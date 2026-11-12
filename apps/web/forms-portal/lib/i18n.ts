/**
 * The portal's languages and the small text helpers around its strings. The
 * strings themselves live in @weldsuite/i18n (`formsPortal`, en and nl); the
 * server picks the language and sends that one dictionary with the page
 * (lib/page-data.ts), so the browser never loads the other.
 *
 * Which language: the form's own `presentation.language`, then the `locale`
 * cookie (the convention of @weldsuite/i18n's cookie adapter), then
 * Accept-Language, then English.
 */
import type { formsPortal } from '@weldsuite/i18n/locales/en/forms-portal'

export type Locale = 'en' | 'nl'
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'locale'

export type PortalStrings = typeof formsPortal

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'nl'
}

function cookieLocale(cookieHeader: string | null): Locale | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key !== LOCALE_COOKIE) continue
    let decoded = ''
    try {
      decoded = decodeURIComponent(value.join('='))
    } catch {
      return undefined
    }
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

/** The language of a request: the form's own (when it has one), the `locale` cookie, Accept-Language, English. */
export function localeFromRequest(cookieHeader: string | null, acceptLanguage: string | null, formLanguage?: string | null): Locale {
  if (isLocale(formLanguage)) return formLanguage
  return cookieLocale(cookieHeader) ?? acceptedLocale(acceptLanguage) ?? DEFAULT_LOCALE
}

/** `{name}` placeholders replaced by values; an unknown placeholder stays as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}
