import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { SIGN_DISCLOSURE_VERSION } from '@weldsuite/app-api-client/schemas/weldsign'
import { localeFromAcceptLanguage, type Locale } from '@/lib/i18n'

/**
 * First-paint language and the disclosure version this portal shows. A server
 * function, so the schema package the version comes from never ships to the
 * browser.
 */
export const getPageData = createServerFn({ method: 'GET' }).handler(
  (): { locale: Locale; disclosureVersion: string } => ({
    locale: localeFromAcceptLanguage(getRequestHeader('accept-language')),
    disclosureVersion: SIGN_DISCLOSURE_VERSION,
  }),
)
