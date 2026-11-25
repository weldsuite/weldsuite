import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign'
import { dictionaries } from '@/lib/i18n'
import { PortalApiError } from '@/lib/portal-client'
import { PortalProvider } from './portal-context'
import { SignView } from './sign-view'

// The document itself needs pdf.js; these tests are about the frame around it.
vi.mock('./document-view', () => ({ DocumentView: () => null }))

const t = dictionaries.en

function envelope(over: Partial<SignPortalEnvelope> = {}): SignPortalEnvelope {
  return {
    title: 'Contract',
    senderName: 'Bob',
    message: null,
    brand: { name: 'Acme', color: null, logoUrl: null },
    recipient: { name: 'Ann Peeters', email: 'ann@example.com', status: 'opened', consented: true },
    documents: [],
    fields: [],
    signatureLevel: 'qes',
    trustProvider: 'Test QTSP',
    ...over,
  } as unknown as SignPortalEnvelope
}

function show(props: Partial<Parameters<typeof SignView>[0]> & { envelope: SignPortalEnvelope }) {
  return render(
    <PortalProvider value={{ locale: 'en', t, brandColor: null, brandForeground: null }}>
      <SignView
        disclosureVersion="2026-10-24"
        withSession={vi.fn()}
        onEnvelope={vi.fn()}
        onLocaleChange={vi.fn()}
        {...props}
      />
    </PortalProvider>,
  )
}

afterEach(cleanup)

// jsdom has no canvas; the signature pad asks for one.
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement['getContext']

describe('SignView for a qualified signer', () => {
  it('names the level and the provider, and words Finish for the provider', () => {
    show({ envelope: envelope() })
    expect(screen.getByText(t.eidas.confirmWith('Test QTSP'), { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: t.eidas.finish('Test QTSP') })).toBeTruthy()
  })

  it('says why the signer is back from the provider', () => {
    show({ envelope: envelope(), returned: 'cancelled' })
    expect(screen.getByRole('alert').textContent).toBe(t.eidas.returnedCancelled)
  })

  it('starts the round trip at the provider, and says so when signing with a certificate is down', async () => {
    const withSession = vi.fn().mockRejectedValue(new PortalApiError(503, 'SERVICE_UNAVAILABLE', 'down', null))
    show({ envelope: envelope(), withSession })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.eidas.finish('Test QTSP') }))
    })
    expect(withSession).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe(t.eidas.unavailable)
  })

  it('lets the signer try again after coming back with the Back button', async () => {
    // Never answers: the signer is on their way to the provider.
    const withSession = vi.fn().mockReturnValue(new Promise(() => {}))
    show({ envelope: envelope(), withSession })
    fireEvent.click(screen.getByRole('button', { name: t.eidas.finish('Test QTSP') }))
    expect(screen.getByRole('button', { name: t.eidas.finishing })).toBeTruthy()
    await act(async () => {
      const event = new Event('pageshow') as PageTransitionEvent
      Object.defineProperty(event, 'persisted', { value: true })
      window.dispatchEvent(event)
    })
    expect(screen.getByRole('button', { name: t.eidas.finish('Test QTSP') })).toBeTruthy()
  })

  it('asks for consent first, with the level in view', () => {
    show({ envelope: envelope({ recipient: { name: 'Ann', email: 'a@example.com', status: 'opened', consented: false } as SignPortalEnvelope['recipient'] }) })
    expect(screen.getAllByText(t.eidas.levelTitle.qes, { exact: false }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: t.eidas.finish('Test QTSP') })).toBeNull()
  })
})
