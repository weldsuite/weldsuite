/**
 * Display formatting. Everything is deterministic between the server render
 * and the browser (no local time zone), so the page hydrates without warnings.
 */

import type { Address, Locale } from './contract'

const BCP47: Record<Locale, string> = { en: 'en-GB', nl: 'nl-NL' }

/** An amount string ("312.18") in the document's currency. */
export function formatMoney(amount: string, currency: string, locale: Locale): string {
  const value = Number(amount)
  try {
    return new Intl.NumberFormat(BCP47[locale], { style: 'currency', currency }).format(value)
  } catch {
    // An unknown currency code: show the number and the code.
    return `${new Intl.NumberFormat(BCP47[locale], { minimumFractionDigits: 2 }).format(value)} ${currency}`
  }
}

/** A quantity or a rate ("2", "21", "1.5"): no trailing zeros. */
export function formatNumber(value: string, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale], { maximumFractionDigits: 4 }).format(Number(value))
}

/** "2026-11-15" as a long date. A date has no time zone, so it never shifts a day. */
export function formatDate(value: string, locale: Locale): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(BCP47[locale], { dateStyle: 'long', timeZone: 'UTC' }).format(date)
}

/** A moment in UTC, labelled as such. */
export function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(BCP47[locale], { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC', timeZoneName: 'short' }).format(date)
}

/** The lines of an address, empty ones left out: street, then "postal code city", then country. */
export function addressLines(address: Address | null | undefined): string[] {
  if (!address) return []
  const place = [address.postalCode, address.city].filter(Boolean).join(' ')
  return [address.line1, address.line2, place, address.country].filter((line): line is string => Boolean(line && line.trim()))
}

/** Is a decimal string above zero? Compared as text-safe numbers (cents precision is plenty here). */
export function isPositive(amount: string): boolean {
  return Number(amount) > 0.000001
}

/** A logo is shown only from a secure address (or a data URL): never a script or a plain-http image. */
export function safeImageUrl(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(value)) return value
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}
