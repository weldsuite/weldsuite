import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcceptQuoteForm } from '@/components/accept-quote-form'
import { DocumentPage } from '@/components/document-page'
import { PayButton } from '@/components/pay-button'
import { dictionaries } from '@/lib/i18n'
import type { PortalActions } from '@/lib/actions'
import { makeDocument, makeQuote } from './fixtures'

afterEach(cleanup)
const t = dictionaries.en

function actions(overrides: Partial<PortalActions> = {}): PortalActions {
  return {
    pay: vi.fn(async () => ({ ok: true as const, data: { checkoutUrl: 'https://mollie.test/c' } })),
    accept: vi.fn(async () => ({ ok: true as const, data: { acceptedAt: '2026-11-20T10:00:00Z', acceptedBy: 'Piet' } })),
    navigate: vi.fn(),
    ...overrides,
  }
}

function fillValid() {
  fireEvent.change(screen.getByLabelText(t.accept.name), { target: { value: ' Piet ' } })
  fireEvent.change(screen.getByLabelText(new RegExp(t.accept.email)), { target: { value: 'p@x.test' } })
  fireEvent.click(screen.getByRole('checkbox'))
}

describe('PayButton', () => {
  it('pays once on two quick taps and navigates', async () => {
    const a = actions()
    render(<PayButton t={t} label="Pay now" pay={a.pay} navigate={a.navigate} />)
    const button = screen.getByRole('button')
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(a.navigate).toHaveBeenCalledWith('https://mollie.test/c'))
    expect(a.pay).toHaveBeenCalledTimes(1)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows an error and allows a retry', async () => {
    const a = actions({ pay: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })) })
    render(<PayButton t={t} label="Pay now" pay={a.pay} navigate={a.navigate} />)
    fireEvent.click(screen.getByRole('button'))
    expect((await screen.findByRole('alert')).textContent).toBe(t.pay.unavailable)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
    expect(a.navigate).not.toHaveBeenCalled()
  })
})

describe('AcceptQuoteForm', () => {
  it('shows an error only after the field is left', () => {
    render(<AcceptQuoteForm t={t} accept={actions().accept} onAccepted={() => {}} />)
    const name = screen.getByLabelText(t.accept.name)
    expect(name.getAttribute('aria-invalid')).not.toBe('true')
    fireEvent.blur(name)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByText(t.accept.nameRequired).length).toBeGreaterThan(0)
  })

  it('a failed submit focuses the first invalid field and does not call', () => {
    const a = actions()
    render(<AcceptQuoteForm t={t} accept={a.accept} onAccepted={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: t.accept.submit }))
    expect(document.activeElement).toBe(screen.getByLabelText(t.accept.name))
    expect(a.accept).not.toHaveBeenCalled()
  })

  it('submits valid input', async () => {
    const a = actions()
    const onAccepted = vi.fn()
    render(<AcceptQuoteForm t={t} accept={a.accept} onAccepted={onAccepted} />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: t.accept.submit }))
    await waitFor(() => expect(onAccepted).toHaveBeenCalled())
    expect(a.accept).toHaveBeenCalledWith({ name: 'Piet', email: 'p@x.test', agree: true })
  })

  it('shows a failure from the server', async () => {
    const a = actions({ accept: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const })) })
    render(<AcceptQuoteForm t={t} accept={a.accept} onAccepted={() => {}} />)
    fillValid()
    fireEvent.click(screen.getByRole('button', { name: t.accept.submit }))
    expect((await screen.findByRole('alert')).textContent).toBe(t.accept.conflict)
  })
})

describe('DocumentPage', () => {
  it('an open invoice offers payment and a pdf link', () => {
    render(<DocumentPage document={makeDocument()} locale="en" pdfHref="/d/tok/pdf" actions={actions()} />)
    expect(screen.getAllByText('INV-2026-0042').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
    expect(document.querySelector('a[href="/d/tok/pdf"]')).not.toBeNull()
  })

  it('a paid invoice has no pay button', () => {
    const paid = makeDocument({
      status: 'paid',
      totals: { subtotal: '200.00', taxes: [], total: '242.00', paid: '242.00', balanceDue: '0.00' },
    })
    render(<DocumentPage document={paid} locale="en" pdfHref="/p" actions={actions()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a quote shows the accept form, in Dutch when asked', () => {
    render(<DocumentPage document={makeQuote()} locale="nl" pdfHref="/p" actions={actions()} />)
    expect(screen.getByText(dictionaries.nl.accept.title)).toBeTruthy()
  })
})
