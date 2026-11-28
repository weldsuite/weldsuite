import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, newNonce } from '../node/security.mjs'

describe('content security policy', () => {
  it('nonces are fresh', () => {
    const a: string = newNonce()
    expect(a).not.toBe(newNonce())
    expect(a).toMatch(/^[A-Za-z0-9+/=]{22,}$/)
  })
  it('allows only nonced scripts and no inline styles', () => {
    const csp: string = contentSecurityPolicy('N0NCE')
    expect(csp).toContain("script-src 'nonce-N0NCE' 'strict-dynamic'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
  })
})
