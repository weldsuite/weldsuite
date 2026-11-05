import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { LOCALE_COOKIE, isLocale, localeFromRequest, type Locale, type PortalStrings } from '@/lib/i18n'
import { dictionaryFor } from '@/lib/server/dictionaries'

export interface PageData {
  locale: Locale
  strings: PortalStrings
}

/**
 * The language of the request and its dictionary. A server function, so the
 * dictionaries stay out of the browser bundle: the page carries just the one
 * the reader needs, and a language switch asks for the other.
 */
export const getPageData = createServerFn({ method: 'GET' }).handler((): PageData => {
  const request = getRequest()
  const locale = localeFromRequest(request.headers.get('cookie'), request.headers.get('accept-language'))
  return { locale, strings: dictionaryFor(locale) }
})

/** Remember the reader's language (a year); the caller then reloads the root data. */
export const setLanguage = createServerFn({ method: 'POST' })
  .validator((input: { locale: Locale }) => {
    if (!isLocale(input.locale)) throw new Error('Unsupported language')
    return input
  })
  .handler(({ data }): { locale: Locale } => {
    const secure = new URL(getRequest().url).protocol === 'https:'
    setCookie(LOCALE_COOKIE, data.locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', secure })
    return { locale: data.locale }
  })
