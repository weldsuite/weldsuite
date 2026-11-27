import { describe, expect, it } from 'vitest'
import { addressLines, formatDate, formatMoney, isPositive, safeImageUrl } from '@/lib/format'
import { chooseLocale, dictionaries, localeFromAcceptLanguage, localeOfLoaderData } from '@/lib/i18n'

describe('format', () => {
  it('formats money per locale', () => {
    expect(formatMoney('1234.5', 'EUR', 'en')).toBe('€1,234.50')
    expect(formatMoney('1234.5', 'EUR', 'nl').replace(/\s/g, ' ')).toBe('€ 1.234,50')
  })
  it('falls back on an unknown currency code', () => {
    expect(formatMoney('5', 'XXX', 'en')).toContain('5')
  })
  it('a date never shifts a day', () => {
    expect(formatDate('2026-11-15', 'en')).toBe('15 November 2026')
    expect(formatDate('2026-11-15', 'nl')).toBe('15 november 2026')
  })
  it('address lines skip empty parts', () => {
    expect(addressLines({ line1: 'Street 1', line2: ' ', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' })).toEqual([
      'Street 1',
      '1234 AB Utrecht',
      'NL',
    ])
    expect(addressLines(null)).toEqual([])
  })
  it('isPositive', () => {
    expect(isPositive('0.00')).toBe(false)
    expect(isPositive('0.01')).toBe(true)
  })
  it('logo urls must be https or an image data url', () => {
    expect(safeImageUrl('https://x.test/l.png')).toBe('https://x.test/l.png')
    expect(safeImageUrl('http://x.test/l.png')).toBeNull()
    expect(safeImageUrl('javascript:alert(1)')).toBeNull()
    expect(safeImageUrl('data:image/png;base64,AAA')).not.toBeNull()
    expect(safeImageUrl(null)).toBeNull()
  })
})

describe('locale', () => {
  it('reads Accept-Language', () => {
    expect(localeFromAcceptLanguage('fr-FR, nl-NL;q=0.8, en;q=0.5')).toBe('nl')
    expect(localeFromAcceptLanguage('de')).toBeNull()
    expect(localeFromAcceptLanguage(null)).toBeNull()
  })
  it('the document language wins over the browser', () => {
    expect(chooseLocale('nl', 'en')).toBe('nl')
    expect(chooseLocale(null, 'nl-NL')).toBe('nl')
    expect(chooseLocale(null, 'de')).toBe('en')
  })
  it('loader data carries a locale', () => {
    expect(localeOfLoaderData('nl')).toBe('nl')
    expect(localeOfLoaderData({ locale: 'en' })).toBe('en')
    expect(localeOfLoaderData({})).toBeNull()
  })
  it('en and nl have the same keys', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix]
    expect(keys(dictionaries.nl).sort()).toEqual(keys(dictionaries.en).sort())
  })
})
