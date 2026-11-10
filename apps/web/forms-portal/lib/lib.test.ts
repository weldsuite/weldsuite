import { describe, expect, it } from 'vitest'
import { frameAncestors } from './csp'
import { hiddenFromSearch, isSafeUrl, parseUserAgent, utmFromSearch } from './client/environment'
import { forwardedClientIp } from './forwarded-ip'
import { parseInvitation } from './invitation'
import { localeFromRequest } from './i18n'

describe('hiddenFromSearch', () => {
  it('keeps only declared names, as written', () => {
    const search = '?embed=popup&plan=007&utm_source=x&unknown=1&source=qr'
    expect(hiddenFromSearch(search, ['plan', 'utm_source', 'embed'])).toEqual({ plan: '007', utm_source: 'x' })
  })
  it('cuts long values', () => {
    expect(hiddenFromSearch(`?a=${'x'.repeat(2000)}`, ['a']).a).toHaveLength(1000)
  })
})

describe('utmFromSearch', () => {
  it('reads utm tags only', () => {
    expect(utmFromSearch('?utm_source=news&UTM_medium=mail&other=1')).toEqual({ utm_source: 'news', utm_medium: 'mail' })
  })
})

describe('parseUserAgent', () => {
  it('reads common browsers', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    expect(parseUserAgent(chrome)).toEqual({ device: 'desktop', browser: 'Chrome', os: 'Windows' })
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(parseUserAgent(iphone)).toEqual({ device: 'phone', browser: 'Safari', os: 'iOS' })
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel Tablet) Chrome/120.0 Safari/537.36').device).toBe('tablet')
  })
})

describe('isSafeUrl', () => {
  it('allows web links only', () => {
    expect(isSafeUrl('https://example.com/a')).toBe(true)
    expect(isSafeUrl('/thanks')).toBe(true)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,x')).toBe(false)
  })
})

describe('frameAncestors', () => {
  it('allows any site by default', () => {
    expect(frameAncestors([])).toBe('frame-ancestors *')
    expect(frameAncestors(['example.com', '*'])).toBe('frame-ancestors *')
  })
  it('lists the allowed sites', () => {
    expect(frameAncestors(['example.com', '*.shop.nl', 'https://app.test:8443/path'])).toBe(
      'frame-ancestors https://example.com https://*.shop.nl https://app.test:8443',
    )
  })
  it('refuses framing when no entry is usable', () => {
    expect(frameAncestors(["evil.com; script-src *", 'a b'])).toBe("frame-ancestors 'none'")
  })
})

describe('forwardedClientIp', () => {
  it('counts trusted proxies from the right', () => {
    expect(forwardedClientIp('1.1.1.1, 2.2.2.2', 1)).toBe('2.2.2.2')
    expect(forwardedClientIp('6.6.6.6, 1.1.1.1, 2.2.2.2', 2)).toBe('1.1.1.1')
    expect(forwardedClientIp('', 1)).toBeNull()
    expect(forwardedClientIp('not-an-ip!', 1)).toBeNull()
  })
})

describe('parseInvitation', () => {
  it('splits the public id from the token', () => {
    const token = 'a'.repeat(32)
    expect(parseInvitation(`abc123DEFg.${token}`)).toEqual({ publicId: 'abc123DEFg', token })
    expect(parseInvitation(token)).toBeNull()
    expect(parseInvitation('abc.short')).toBeNull()
  })
})

describe('localeFromRequest', () => {
  it('prefers the form language, then the cookie, then Accept-Language', () => {
    expect(localeFromRequest('locale=nl', 'en', 'en')).toBe('en')
    expect(localeFromRequest('locale=nl', 'en')).toBe('nl')
    expect(localeFromRequest(null, 'nl-NL,nl;q=0.9,en;q=0.8')).toBe('nl')
    expect(localeFromRequest(null, 'fr-FR')).toBe('en')
  })
})
