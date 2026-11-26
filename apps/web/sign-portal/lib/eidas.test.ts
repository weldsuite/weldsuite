import { describe, expect, it, vi } from 'vitest'
import type { SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign'
import {
  finishErrorMessage,
  finishLabel,
  hasEvidenceReport,
  isProviderUrl,
  pdfFileName,
  readSignatureReturn,
  startProviderSignature,
} from './eidas'
import { dictionaries } from './i18n'
import { PortalApiError, PortalNetworkError } from './portal-client'

const t = dictionaries.en

const apiError = (status: number) => new PortalApiError(status, 'X', 'x', null)

describe('finishErrorMessage', () => {
  it('names a network problem, an expired session and anything else', () => {
    expect(finishErrorMessage(new PortalNetworkError(), undefined, t)).toBe(t.error.network)
    expect(finishErrorMessage(apiError(401), 'qes', t)).toBe(t.sign.sessionExpired)
    expect(finishErrorMessage(apiError(400), undefined, t)).toBe(t.sign.finishFailed)
    expect(finishErrorMessage(new Error('boom'), 'aes', t)).toBe(t.sign.finishFailed)
  })

  it('tells a 503 apart by level', () => {
    expect(finishErrorMessage(apiError(503), undefined, t)).toBe(t.sign.finishPending)
    expect(finishErrorMessage(apiError(503), 'qes', t)).toBe(t.eidas.unavailable)
  })
})

describe('finishLabel', () => {
  it('sends an advanced or qualified signer to their provider', () => {
    expect(finishLabel(false, 'qes', 'Test QTSP', t)).toBe(t.eidas.finish('Test QTSP'))
    expect(finishLabel(true, 'aes', null, t)).toBe(t.eidas.finishing)
  })

  it('finishes a simple signer here', () => {
    expect(finishLabel(false, undefined, null, t)).toBe(t.sign.finish)
    expect(finishLabel(true, undefined, null, t)).toBe(t.sign.finishing)
  })
})

describe('the provider round trip', () => {
  it('follows web addresses only', () => {
    expect(isProviderUrl('https://qtsp.example/authorize?x=1')).toBe(true)
    expect(isProviderUrl('http://localhost:3023/signature-callback')).toBe(true)
    expect(isProviderUrl('javascript:alert(1)')).toBe(false)
    expect(isProviderUrl('/signature-callback')).toBe(false)
  })

  it('sends the signer to the address the backend answers with', async () => {
    const go = vi.fn()
    const withSession = vi.fn().mockResolvedValue({ redirectUrl: 'https://qtsp.example/authorize?state=s1' })
    await startProviderSignature(withSession, { values: [], signature: null, initials: null, timeZone: null }, go)
    expect(withSession).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith('https://qtsp.example/authorize?state=s1')
  })

  it('refuses to follow anything but a web address', async () => {
    const go = vi.fn()
    const withSession = vi.fn().mockResolvedValue({ redirectUrl: 'javascript:alert(1)' })
    await expect(
      startProviderSignature(withSession, { values: [], signature: null, initials: null, timeZone: null }, go),
    ).rejects.toThrow('Unexpected redirect')
    expect(go).not.toHaveBeenCalled()
  })

  it('reads why the signer is back', () => {
    expect(readSignatureReturn('?signature=failed')).toBe('failed')
    expect(readSignatureReturn('?signature=cancelled&x=1')).toBe('cancelled')
    expect(readSignatureReturn('?signature=other')).toBeNull()
    expect(readSignatureReturn('')).toBeNull()
  })
})

describe('downloads', () => {
  const envelope = (over: Partial<SignPortalEnvelope>) => ({ title: 'Contract', ...over }) as SignPortalEnvelope

  it('offers the evidence report when the backend says so, or for an AES/QES signer', () => {
    expect(hasEvidenceReport(envelope({ hasEvidence: true }))).toBe(true)
    expect(hasEvidenceReport(envelope({ hasEvidence: false, signatureLevel: 'qes' }))).toBe(false)
    expect(hasEvidenceReport(envelope({ signatureLevel: 'aes' }))).toBe(true)
    expect(hasEvidenceReport(envelope({}))).toBe(false)
  })

  it('makes a safe file name', () => {
    expect(pdfFileName('Lease: unit 4/B')).toBe('Lease  unit 4 B.pdf')
    expect(pdfFileName('Contract', ' - evidence')).toBe('Contract - evidence.pdf')
    expect(pdfFileName('  ')).toBe('document.pdf')
  })
})
