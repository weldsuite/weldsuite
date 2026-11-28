import { describe, expect, it } from 'vitest'
import { formDefinitionSchema } from '@weldsuite/forms-engine'
import { formsPortal } from '@weldsuite/i18n/locales/en/forms-portal'
import { frameAncestors } from './csp'
import { ApiError } from './client/api'
import { hiddenFromSearch, isSafeUrl, parseUserAgent, prefillFromSearch, utmFromSearch } from './client/environment'
import { submitRefusal } from './client/submit-errors'
import { MIN_FILL_MS, submitWaitMs } from './client/submit-timing'
import { forwardedClientIp } from './forwarded-ip'
import { formCacheKey, requestHost } from './host'
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

describe('prefillFromSearch', () => {
  const definition = formDefinitionSchema.parse({
    blocks: [
      { id: 'b_name', type: 'short_text', ref: 'what_is_your_name', title: 'Name', properties: {} },
      { id: 'b_age', type: 'number', ref: 'age', title: 'Age', properties: {} },
      { id: 'b_ok', type: 'yes_no', ref: 'customer', title: 'Customer?', properties: {} },
      {
        id: 'b_color',
        type: 'multiple_choice',
        ref: 'color',
        title: 'Colors',
        properties: { multiple: true, choices: [{ id: 'c_red', label: 'Red' }, { id: 'c_blue', label: 'Blue' }] },
      },
      { id: 'b_plan', type: 'dropdown', ref: 'plan', title: 'Plan', properties: { choices: [{ id: 'c_pro', label: 'Pro' }, { id: 'c_free', label: 'Free' }] } },
      { id: 'b_terms', type: 'legal', ref: 'terms', title: 'Terms', properties: {} },
    ],
    endings: [{ id: 'e_done', ref: 'done', title: 'Thanks' }],
  })

  it('fills questions in by their reference', () => {
    const search = '?what_is_your_name=Prefilled&age=42&customer=yes&color=red,Blue&plan=pro&terms=true&other=1'
    expect(prefillFromSearch(search, definition)).toEqual({
      b_name: 'Prefilled',
      b_age: 42,
      b_ok: true,
      b_color: { choiceIds: ['c_red', 'c_blue'] },
      b_plan: { choiceIds: ['c_pro'] },
    })
  })

  it('ignores values that do not fit the question', () => {
    expect(prefillFromSearch('?age=many&customer=maybe&color=Green&plan=&what_is_your_name=', definition)).toEqual({})
  })
})

describe('submitRefusal', () => {
  const t = formsPortal
  it('keeps the connection message for a request without an answer', () => {
    expect(submitRefusal(new ApiError(0, 'NETWORK', 'Network error'), t)).toBeNull()
    expect(submitRefusal(new Error('boom'), t)).toBeNull()
  })
  it('says why forms-api refused the submit', () => {
    expect(submitRefusal(new ApiError(400, 'SUBMISSION_REJECTED', 'x'), t)).toBe(t.submit.rejected)
    expect(submitRefusal(new ApiError(429, 'RATE_LIMITED', 'x'), t)).toBe(t.submit.rateLimited)
    expect(submitRefusal(new ApiError(403, 'FORM_CLOSED', 'x', { state: 'past_close_date' }), t)).toBe(
      `${t.states.past_close_date.title}. ${t.states.past_close_date.body}`,
    )
    expect(submitRefusal(new ApiError(500, 'INTERNAL', 'x'), t)).toBe(t.submit.failed)
  })
})

describe('submitWaitMs', () => {
  it('waits out what is left of the minimum since the session started, and no more', () => {
    expect(submitWaitMs(10_000, 10_080)).toBe(MIN_FILL_MS + 100 - 80)
    expect(submitWaitMs(10_000, 10_000 + MIN_FILL_MS + 100)).toBe(0)
    expect(submitWaitMs(10_000, 60_000)).toBe(0)
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

describe('requestHost', () => {
  it('is the lower-case host name, without port', () => {
    expect(requestHost({ url: 'https://Forms.Acme.com:8443/f/abc' })).toBe('forms.acme.com')
    expect(requestHost({ url: 'http://localhost:3025/' })).toBe('localhost')
  })
  it('is null for a URL that does not parse', () => {
    expect(requestHost({ url: 'not a url' })).toBeNull()
  })
})

describe('formCacheKey', () => {
  it('keeps one form apart per host', () => {
    expect(formCacheKey('forms.acme.com', 'abc')).not.toBe(formCacheKey('forms.weldsuite.eu', 'abc'))
    expect(formCacheKey(null, 'abc')).toBe('|abc')
  })
})
