/**
 * Dates, money and numbers in the reader's language (Intl). Money arrives as a
 * decimal string and a currency code; dates as ISO strings.
 */
import type { Locale } from '@/lib/i18n'

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', nl: 'nl-NL' }

export interface Formatters {
  /** `30 Oct`, with the year when it is not this year (`15 Jan 2027`); empty for a missing or invalid date. */
  date(iso: string | null | undefined): string
  /** The date and the time of day: `30 Oct, 14:05`; the year as in `date`. */
  dateTime(iso: string | null | undefined): string
  /** A decimal string in a currency (`7500.00`, `EUR` -> `€7,500`); the plain number without a currency. */
  money(amount: string | null | undefined, currency: string | null | undefined): string
  /** A whole number with its sign (`+6`, `-2`, `0`). */
  signed(value: number): string
  percent(value: number): string
  /** A file size: `812 B`, `1.4 MB`. */
  bytes(size: number): string
  /** An ISO week (`2026-W45`) as its week number and a month (`2026-11`) as `November 2026`; null when it is neither. */
  period(period: string, weekLabel: (week: number) => string): string
}

const WEEK = /^(\d{4})-W(\d{1,2})$/
const MONTH = /^(\d{4})-(\d{2})$/

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * `timeZone` is UTC while the server renders and the browser's own once the
 * page is interactive, so the markup the server sends is the markup the
 * browser first renders and a date still reads in the reader's day.
 */
export function createFormatters(locale: Locale, timeZone: string | undefined): Formatters {
  const intl = INTL_LOCALE[locale]
  const sameYear = new Intl.DateTimeFormat(intl, { day: 'numeric', month: 'short', timeZone })
  const otherYear = new Intl.DateTimeFormat(intl, { day: 'numeric', month: 'short', year: 'numeric', timeZone })
  const timeSameYear = new Intl.DateTimeFormat(intl, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
  const timeOtherYear = new Intl.DateTimeFormat(intl, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
  const year = new Intl.DateTimeFormat(intl, { year: 'numeric', timeZone })
  const month = new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const signedNumber = new Intl.NumberFormat(intl, { signDisplay: 'exceptZero' })
  const percentNumber = new Intl.NumberFormat(intl, { style: 'percent', maximumFractionDigits: 0 })
  const plainNumber = new Intl.NumberFormat(intl, { maximumFractionDigits: 2 })
  const sizeNumber = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 })
  const currencies = new Map<string, Intl.NumberFormat>()

  function currencyFormat(code: string): Intl.NumberFormat | null {
    const cached = currencies.get(code)
    if (cached) return cached
    try {
      const format = new Intl.NumberFormat(intl, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })
      currencies.set(code, format)
      return format
    } catch {
      return null
    }
  }

  return {
    date(iso) {
      const date = parse(iso)
      if (!date) return ''
      return year.format(date) === year.format(new Date()) ? sameYear.format(date) : otherYear.format(date)
    },
    dateTime(iso) {
      const date = parse(iso)
      if (!date) return ''
      return year.format(date) === year.format(new Date()) ? timeSameYear.format(date) : timeOtherYear.format(date)
    },
    money(amount, currency) {
      if (amount === null || amount === undefined || amount === '') return ''
      const value = Number(amount)
      if (!Number.isFinite(value)) return ''
      const format = currency ? currencyFormat(currency.toUpperCase()) : null
      return format ? format.format(value) : plainNumber.format(value)
    },
    signed: (value) => signedNumber.format(value),
    percent: (value) => percentNumber.format(value / 100),
    bytes(size) {
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${sizeNumber.format(size / 1024)} KB`
      if (size < 1024 * 1024 * 1024) return `${sizeNumber.format(size / (1024 * 1024))} MB`
      return `${sizeNumber.format(size / (1024 * 1024 * 1024))} GB`
    },
    period(period, weekLabel) {
      const week = WEEK.exec(period)
      if (week) return weekLabel(Number(week[2]))
      const monthly = MONTH.exec(period)
      if (monthly) return month.format(new Date(Date.UTC(Number(monthly[1]), Number(monthly[2]) - 1, 1)))
      return period
    },
  }
}

/** The initials of a name: `Femke de Graaf` -> `FG`. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]!.charAt(0)
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : ''
  return `${first}${last}`.toUpperCase()
}
