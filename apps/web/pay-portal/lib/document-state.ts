/** What the page shows for a document's state: banners, whether to offer payment and acceptance. */

import type { PublicDocument } from './contract'
import { isPositive } from './format'

export type BannerKind = 'paid' | 'partially_paid' | 'overdue' | 'cancelled' | 'pending' | 'accepted' | 'declined' | 'expired'

/** An invoice is settled when the backend says so, or nothing is left to pay. */
export function isPaid(document: PublicDocument): boolean {
  if (document.kind !== 'invoice') return false
  if (document.status === 'cancelled') return false
  return document.status === 'paid' || document.payment.status === 'paid' || !isPositive(document.totals.balanceDue)
}

/** "Pay now": an invoice with online payment on and a balance still open. */
export function canPay(document: PublicDocument): boolean {
  if (document.kind !== 'invoice' || !document.payment.enabled) return false
  if (document.status === 'cancelled' || isPaid(document)) return false
  return isPositive(document.totals.balanceDue)
}

/** Bank-transfer details are for an invoice that still has a balance. */
export function showTransferDetails(document: PublicDocument): boolean {
  return document.kind === 'invoice' && document.status !== 'cancelled' && !isPaid(document) && Boolean(document.seller.iban)
}

/** "Accept quote": the backend says the quote can be accepted, and it has not been. */
export function canAccept(document: PublicDocument): boolean {
  return document.kind === 'quote' && document.quote !== null && document.quote.canAccept && !document.quote.acceptedAt
}

/** The one banner for the state, or null for a plain open document. */
export function bannerFor(document: PublicDocument): BannerKind | null {
  if (document.status === 'cancelled') return 'cancelled'
  if (document.kind === 'quote') {
    if (document.quote?.acceptedAt || document.status === 'accepted') return 'accepted'
    if (document.status === 'declined') return 'declined'
    if (document.status === 'expired') return 'expired'
    return null
  }
  if (isPaid(document)) return 'paid'
  if (document.payment.status === 'pending') return 'pending'
  if (document.status === 'overdue') return 'overdue'
  if (document.status === 'partially_paid' || isPositive(document.totals.paid)) return 'partially_paid'
  return null
}

/** What the return page reports after Mollie sends the customer back. */
export type PaymentOutcome = 'received' | 'pending' | 'not_completed'

export function paymentOutcome(document: PublicDocument): PaymentOutcome {
  if (isPaid(document)) return 'received'
  if (document.payment.status === 'pending') return 'pending'
  return 'not_completed'
}
