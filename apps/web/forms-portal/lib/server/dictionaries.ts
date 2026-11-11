/**
 * Server-only: the two dictionaries. Typing both as `PortalStrings` is the
 * guard that nl has every key en has. Never import this from a client file:
 * it is only reached from server function handlers, so the browser bundle
 * carries neither.
 */
import { formsPortal as en } from '@weldsuite/i18n/locales/en/forms-portal'
import { formsPortal as nl } from '@weldsuite/i18n/locales/nl/forms-portal'
import type { Locale, PortalStrings } from '@/lib/i18n'

const dictionaries: Record<Locale, PortalStrings> = { en, nl }

export function dictionaryFor(locale: Locale): PortalStrings {
  return dictionaries[locale]
}
