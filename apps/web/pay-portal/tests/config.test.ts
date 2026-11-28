import { afterEach, describe, expect, it, vi } from 'vitest'
import { backendBaseUrl, publicOrigin } from '../lib/server/config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('backendBaseUrl', () => {
  it('drops trailing slashes and keeps the rest', () => {
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', 'http://localhost:8789///')
    expect(backendBaseUrl()).toBe('http://localhost:8789')
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', 'http://a.test/api/')
    expect(backendBaseUrl()).toBe('http://a.test/api')
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', 'http://a.test')
    expect(backendBaseUrl()).toBe('http://a.test')
  })

  it('is null while unset, and handles only slashes', () => {
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', '')
    expect(backendBaseUrl()).toBeNull()
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', '///')
    expect(backendBaseUrl()).toBe('')
  })

  it('answers a long run of slashes at once', () => {
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', `http://a.test${'/'.repeat(500_000)}x`)
    const started = performance.now()
    expect(backendBaseUrl()).toBe(`http://a.test${'/'.repeat(500_000)}x`)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('publicOrigin', () => {
  it('uses http for localhost and https otherwise, unless the proxy says', () => {
    vi.stubEnv('PAY_PORTAL_PUBLIC_URL', '')
    expect(publicOrigin(new Headers({ host: 'localhost:3033' }))).toBe('http://localhost:3033')
    expect(publicOrigin(new Headers({ host: 'pay.example.org' }))).toBe('https://pay.example.org')
    expect(publicOrigin(new Headers({ host: 'pay.example.org', 'x-forwarded-proto': 'http' }))).toBe('http://pay.example.org')
  })
})
