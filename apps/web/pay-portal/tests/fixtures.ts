import type { PublicDocument } from '@/lib/contract'

export function makeDocument(overrides: Partial<PublicDocument> = {}): PublicDocument {
  return {
    kind: 'invoice',
    status: 'open',
    number: 'INV-2026-0042',
    issueDate: '2026-11-15',
    dueDate: '2026-12-15',
    validUntil: null,
    currency: 'EUR',
    locale: 'en',
    seller: { name: 'Acme BV', iban: 'NL91ABNA0417164300' },
    buyer: { name: 'Jansen Bouw' },
    lines: [{ description: 'Consulting', quantity: '2', unitPrice: '100.00', taxRate: '21', total: '200.00' }],
    totals: { subtotal: '200.00', taxes: [{ rate: '21', amount: '42.00' }], total: '242.00', paid: '0.00', balanceDue: '242.00' },
    notes: null,
    paymentTerms: null,
    payment: { enabled: true, status: 'open', methods: ['ideal'] },
    quote: null,
    ...overrides,
  }
}

export function makeQuote(overrides: Partial<PublicDocument> = {}): PublicDocument {
  return makeDocument({
    kind: 'quote',
    number: 'Q-2026-0007',
    validUntil: '2026-12-31',
    payment: { enabled: false, status: 'open', methods: [] },
    quote: { canAccept: true, acceptedAt: null, acceptedBy: null },
    ...overrides,
  })
}
