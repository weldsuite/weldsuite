import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeEnv, signerMeta } from './runtime'

afterEach(() => {
  vi.unstubAllEnvs()
})

const request = (headers: Record<string, string>) => new Request('https://sign.example/api/session', { headers })

describe('runtimeEnv', () => {
  it('is the process environment', () => {
    vi.stubEnv('SIGN_PORTAL_BACKEND', 'rust')
    expect(runtimeEnv().SIGN_PORTAL_BACKEND).toBe('rust')
  })
})

describe('signerMeta', () => {
  it('takes the address the ingress saw, and the browser', () => {
    vi.stubEnv('SIGN_PORTAL_TRUSTED_PROXIES', '')
    expect(signerMeta(request({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7', 'user-agent': 'Mozilla/5.0' }))).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    })
  })

  it('counts the trusted proxies from the right', () => {
    vi.stubEnv('SIGN_PORTAL_TRUSTED_PROXIES', '2')
    expect(signerMeta(request({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7, 10.0.0.1' })).ip).toBe('203.0.113.7')
  })

  it('falls back to one proxy when the setting is not a number, and cuts a long user agent', () => {
    vi.stubEnv('SIGN_PORTAL_TRUSTED_PROXIES', 'many')
    const meta = signerMeta(request({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'x'.repeat(600) }))
    expect(meta.ip).toBe('203.0.113.7')
    expect(meta.userAgent).toHaveLength(500)
  })

  it('has no address or browser without the headers', () => {
    expect(signerMeta(request({}))).toEqual({ ip: null, userAgent: null })
  })
})
