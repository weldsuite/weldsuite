import { describe, expect, it } from 'vitest'
import { bannerFor, canAccept, canPay, isPaid, paymentOutcome, showTransferDetails } from '@/lib/document-state'
import { makeDocument, makeQuote } from './fixtures'

const paid = { subtotal: '200.00', taxes: [], total: '242.00', paid: '242.00', balanceDue: '0.00' }

describe('document state', () => {
  it('an open invoice can be paid and has no banner', () => {
    const doc = makeDocument()
    expect(canPay(doc)).toBe(true)
    expect(bannerFor(doc)).toBeNull()
    expect(showTransferDetails(doc)).toBe(true)
  })

  it('a paid invoice shows the paid banner and offers no payment', () => {
    const doc = makeDocument({ status: 'paid', totals: paid })
    expect(isPaid(doc)).toBe(true)
    expect(canPay(doc)).toBe(false)
    expect(bannerFor(doc)).toBe('paid')
    expect(showTransferDetails(doc)).toBe(false)
  })

  it('a zero balance counts as paid even when the status lags', () => {
    expect(isPaid(makeDocument({ totals: paid }))).toBe(true)
  })

  it('an overdue invoice can still be paid', () => {
    const doc = makeDocument({ status: 'overdue' })
    expect(bannerFor(doc)).toBe('overdue')
    expect(canPay(doc)).toBe(true)
  })

  it('a cancelled invoice cannot be paid, even with a zero balance', () => {
    const doc = makeDocument({ status: 'cancelled', totals: paid })
    expect(isPaid(doc)).toBe(false)
    expect(canPay(doc)).toBe(false)
    expect(bannerFor(doc)).toBe('cancelled')
  })

  it('a payment in progress shows pending', () => {
    const doc = makeDocument({ payment: { enabled: true, status: 'pending', methods: [] } })
    expect(bannerFor(doc)).toBe('pending')
    expect(paymentOutcome(doc)).toBe('pending')
  })

  it('a part payment shows partially paid and still allows payment', () => {
    const doc = makeDocument({ totals: { ...paid, paid: '100.00', balanceDue: '142.00' } })
    expect(bannerFor(doc)).toBe('partially_paid')
    expect(canPay(doc)).toBe(true)
  })

  it('no online payment means no pay button', () => {
    expect(canPay(makeDocument({ payment: { enabled: false, status: 'open', methods: [] } }))).toBe(false)
  })

  it('return outcomes', () => {
    expect(paymentOutcome(makeDocument({ status: 'paid', totals: paid }))).toBe('received')
    expect(paymentOutcome(makeDocument())).toBe('not_completed')
  })

  it('a quote can be accepted until it is', () => {
    expect(canAccept(makeQuote())).toBe(true)
    expect(canPay(makeQuote())).toBe(false)
    const accepted = makeQuote({ quote: { canAccept: false, acceptedAt: '2026-11-20T10:00:00Z', acceptedBy: 'A' } })
    expect(canAccept(accepted)).toBe(false)
    expect(bannerFor(accepted)).toBe('accepted')
  })

  it('declined, expired and not-acceptable quotes', () => {
    expect(bannerFor(makeQuote({ status: 'declined' }))).toBe('declined')
    expect(bannerFor(makeQuote({ status: 'expired' }))).toBe('expired')
    expect(canAccept(makeQuote({ quote: { canAccept: false, acceptedAt: null, acceptedBy: null } }))).toBe(false)
  })
})
