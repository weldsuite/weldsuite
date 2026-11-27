import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptQuote, createPayment, getDocument, getPdf, reasonForStatus } from '@/lib/server/backend'
import { makeDocument } from './fixtures'

const TOKEN = 'abcdefgh12345678'
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('PAY_PORTAL_BACKEND_URL', 'http://backend.test/')
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const err = { error: { code: 'c', message: 'm' } }

describe('backend', () => {
  it('maps statuses to reasons', () => {
    expect(reasonForStatus(404)).toBe('not_found')
    expect(reasonForStatus(409)).toBe('conflict')
    expect(reasonForStatus(429)).toBe('rate_limited')
    expect(reasonForStatus(503)).toBe('unavailable')
    expect(reasonForStatus(422)).toBe('invalid')
    expect(reasonForStatus(500)).toBe('network')
  })

  it('fetches a document from the token path', async () => {
    fetchMock.mockResolvedValue(json({ data: makeDocument() }))
    const result = await getDocument(TOKEN)
    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://backend.test/public/weldbooks/documents/${TOKEN}`)
  })

  it('an implausible token costs no call', async () => {
    expect(await getDocument('../etc')).toEqual({ ok: false, reason: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('without a configured backend nothing is fetched', async () => {
    vi.stubEnv('PAY_PORTAL_BACKEND_URL', '')
    expect((await getDocument(TOKEN)).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an answer off the contract is a network failure', async () => {
    fetchMock.mockResolvedValue(json({ data: { nope: true } }))
    expect(await getDocument(TOKEN)).toEqual({ ok: false, reason: 'network' })
  })

  it('a thrown fetch is a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    expect(await getDocument(TOKEN)).toEqual({ ok: false, reason: 'network' })
  })

  it('an unknown token is not_found', async () => {
    fetchMock.mockResolvedValue(json(err, 404))
    expect(await getDocument(TOKEN)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('pay posts the return url and requires an https checkout', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { checkoutUrl: 'https://mollie.test/c/1' } }))
    const ok = await createPayment(TOKEN, 'https://pay.test/d/x/return')
    expect(ok).toEqual({ ok: true, data: { checkoutUrl: 'https://mollie.test/c/1' } })
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ returnUrl: 'https://pay.test/d/x/return' })
    fetchMock.mockResolvedValueOnce(json({ data: { checkoutUrl: 'http://evil.test/' } }))
    expect((await createPayment(TOKEN, 'https://pay.test/r')).ok).toBe(false)
  })

  it('pay conflict and unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json(err, 409))
    expect(await createPayment(TOKEN, 'https://pay.test/r')).toEqual({ ok: false, reason: 'conflict' })
    fetchMock.mockResolvedValueOnce(json(err, 503))
    expect(await createPayment(TOKEN, 'https://pay.test/r')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('accept posts the form', async () => {
    fetchMock.mockResolvedValue(json({ data: { acceptedAt: '2026-11-20T10:00:00Z', acceptedBy: 'Piet' } }))
    const result = await acceptQuote(TOKEN, { name: 'Piet', email: 'p@x.test', agree: true })
    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/accept$/)
  })

  it('the pdf must be a pdf', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-type': 'application/pdf' } }))
    expect((await getPdf(TOKEN)).ok).toBe(true)
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect((await getPdf(TOKEN)).ok).toBe(false)
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 404 }))
    expect(await getPdf(TOKEN)).toEqual({ ok: false, reason: 'not_found' })
  })
})
