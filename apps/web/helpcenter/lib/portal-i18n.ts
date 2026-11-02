import { useLazyI18n, useTranslations } from '@weldsuite/i18n/lazy-provider'
import { readNamespace } from '@weldsuite/i18n/lazy'
import { localeConfig, withEnglishFallback, type Translations } from '@weldsuite/i18n/locales'

export type PortalStrings = Translations['common']['helpcenter']['portal']

/**
 * The portal's strings (`common.helpcenter.portal`) in the reader's language.
 * en and nl are complete; the lazy loader reads a namespace as-is, so for a
 * partial locale (es, fr) the keys it lacks are filled in from English
 * instead of being undefined. Suspends while a chunk loads: use inside
 * `<Suspense>`.
 */
export function usePortalStrings(): PortalStrings {
  const local = useTranslations('common')
  const english = readNamespace('en', 'common')
  return withEnglishFallback(local.helpcenter?.portal, english.helpcenter.portal) as PortalStrings
}

/** The message for a failed portal call's `code` (see lib/portal.ts). */
export function errorText(t: PortalStrings, code: string): string {
  switch (code) {
    case 'INVALID_EMAIL':
      return t.errors.invalidEmail
    case 'INVALID_CODE':
      return t.errors.invalidCode
    case 'CODE_EXPIRED':
      return t.errors.codeExpired
    case 'RATE_LIMITED':
      return t.errors.rateLimited
    case 'UNAVAILABLE':
      return t.errors.unavailable
    default:
      return t.errors.generic
  }
}

/** `{name}` placeholders → values. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

/** Dates in the reader's language. */
export function useDateFormat(): { date: (iso: string) => string; dateTime: (iso: string) => string } {
  const { language } = useLazyI18n()
  const locale = localeConfig[language]?.intlLocale ?? 'en-US'
  const format = (iso: string, options: Intl.DateTimeFormatOptions) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, options).format(d)
  }
  return {
    date: (iso) => format(iso, { dateStyle: 'medium' }),
    dateTime: (iso) => format(iso, { dateStyle: 'medium', timeStyle: 'short' }),
  }
}
