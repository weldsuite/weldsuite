import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign'
import { dictionaries } from '@/lib/i18n'
import { PortalProvider } from './portal-context'
import { CompletedView, WaitingView } from './result-view'

const t = dictionaries.en

function envelope(over: Partial<SignPortalEnvelope> = {}): SignPortalEnvelope {
  return {
    title: 'Contract',
    senderName: 'Bob',
    recipient: { status: 'signed' },
    ...over,
  } as unknown as SignPortalEnvelope
}

function inPortal(node: React.ReactNode) {
  return render(
    <PortalProvider value={{ locale: 'en', t, brandColor: null, brandForeground: null }}>{node}</PortalProvider>,
  )
}

afterEach(cleanup)

describe('CompletedView', () => {
  it('offers the evidence report and names the level for a qualified signer', () => {
    inPortal(<CompletedView envelope={envelope({ signatureLevel: 'qes', hasEvidence: true })} withSession={vi.fn()} />)
    expect(screen.getByRole('button', { name: t.eidas.evidence })).toBeTruthy()
    expect(screen.getByText(t.eidas.signedWith.qes)).toBeTruthy()
  })

  it('offers only the signed PDF for a simple request', () => {
    inPortal(<CompletedView envelope={envelope()} withSession={vi.fn()} />)
    expect(screen.queryByRole('button', { name: t.eidas.evidence })).toBeNull()
    expect(screen.queryByText(t.eidas.signedWith.qes)).toBeNull()
  })

  it('downloads the evidence report through the signer session', async () => {
    const createObjectURL = vi.fn(() => 'blob:evidence')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const withSession = vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]))
    inPortal(<CompletedView envelope={envelope({ signatureLevel: 'aes' })} withSession={withSession} />)
    fireEvent.click(screen.getByRole('button', { name: t.eidas.evidence }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(withSession).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    click.mockRestore()
  })

  it('says so when the download fails', async () => {
    const withSession = vi.fn().mockRejectedValue(new Error('boom'))
    inPortal(<CompletedView envelope={envelope({ signatureLevel: 'aes' })} withSession={withSession} />)
    fireEvent.click(screen.getByRole('button', { name: t.eidas.evidence }))
    expect((await screen.findByRole('alert')).textContent).toBe(t.error.generic)
  })
})

describe('WaitingView', () => {
  it('names the level a signer signed with', () => {
    inPortal(<WaitingView envelope={envelope({ signatureLevel: 'aes' })} />)
    expect(screen.getByText(t.eidas.signedWith.aes)).toBeTruthy()
  })
})
