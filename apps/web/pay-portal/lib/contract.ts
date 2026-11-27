/**
 * The Phase 4 backend's contract for the public document page, mounted
 * unauthenticated under `/public/weldbooks` (ADR BOOKS-014):
 *
 *   GET  /public/weldbooks/documents/{token}         the document
 *   GET  /public/weldbooks/documents/{token}/pdf     application/pdf
 *   POST /public/weldbooks/documents/{token}/pay     { returnUrl } -> { checkoutUrl }
 *   POST /public/weldbooks/documents/{token}/accept  { name, email, agree } -> { acceptedAt, acceptedBy }
 *
 * Success is `{ data }`, failure `{ error: { code, message } }`: 404 an unknown
 * or revoked token, 409 nothing to pay or not acceptable, 429 too many
 * requests, 503 payment not set up. The types and schemas live here, not in
 * the platform: this app is the only reader.
 */

import { z } from 'zod'

/** Decimal amounts and quantities travel as strings, never as floats. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'not a decimal string')

export const addressSchema = z.object({
  line1: z.string().nullish(),
  line2: z.string().nullish(),
  postalCode: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
})
export type Address = z.infer<typeof addressSchema>

export const DOCUMENT_KINDS = ['invoice', 'quote'] as const
export const DOCUMENT_STATUSES = ['open', 'overdue', 'paid', 'partially_paid', 'cancelled', 'accepted', 'declined', 'expired'] as const
export const LOCALES = ['nl', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export const sellerSchema = z.object({
  name: z.string(),
  address: addressSchema.nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  vatNumber: z.string().nullish(),
  registrationNumber: z.string().nullish(),
  iban: z.string().nullish(),
  bic: z.string().nullish(),
  logoUrl: z.string().nullish(),
})

export const lineSchema = z.object({
  description: z.string(),
  quantity: decimal,
  unitPrice: decimal,
  taxRate: decimal,
  total: decimal,
})

export const totalsSchema = z.object({
  subtotal: decimal,
  taxes: z.array(z.object({ rate: decimal, amount: decimal })),
  total: decimal,
  paid: decimal,
  balanceDue: decimal,
})

export const paymentSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(['open', 'pending', 'paid']),
  methods: z.array(z.string()),
})

export const quoteSchema = z.object({
  canAccept: z.boolean(),
  acceptedAt: z.string().nullable(),
  acceptedBy: z.string().nullable(),
})

export const documentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  status: z.enum(DOCUMENT_STATUSES),
  number: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  currency: z.string().length(3),
  // A language this portal has no copy for is not an error: the browser's decides.
  locale: z.enum(LOCALES).nullable().catch(null),
  seller: sellerSchema,
  buyer: z.object({ name: z.string(), address: addressSchema.nullish() }),
  lines: z.array(lineSchema),
  totals: totalsSchema,
  notes: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  payment: paymentSchema,
  quote: quoteSchema.nullable(),
})
export type PublicDocument = z.infer<typeof documentSchema>
export type DocumentLine = z.infer<typeof lineSchema>

export const documentResponseSchema = z.object({ data: documentSchema })

/** Only a secure address is followed: the customer leaves for Mollie's checkout. */
export const payResponseSchema = z.object({
  data: z.object({ checkoutUrl: z.string().url().startsWith('https://') }),
})

export const acceptInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  agree: z.literal(true),
})
export type AcceptInput = z.infer<typeof acceptInputSchema>

export const acceptResponseSchema = z.object({
  data: z.object({ acceptedAt: z.string(), acceptedBy: z.string() }),
})
export type AcceptResult = z.infer<typeof acceptResponseSchema>['data']

export const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

/**
 * What a page or form does with a failed call. The backend's own message is
 * never shown: copy comes from the dictionary, in the document's language.
 */
export type FailureReason =
  /** 404, or a token that cannot be one: unknown, revoked or expired. */
  | 'not_found'
  /** 409: nothing open to pay, or the quote cannot be accepted. */
  | 'conflict'
  /** 429. */
  | 'rate_limited'
  /** 503: online payment is not set up. */
  | 'unavailable'
  /** 400 or 422, or an answer that does not match the contract. */
  | 'invalid'
  /** The backend could not be reached, or answered with something else. */
  | 'network'

export type Result<T> = { ok: true; data: T } | { ok: false; reason: FailureReason }

/** A token the page may send on: a URL-safe credential, not a path. */
export function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9._~-]{8,256}$/.test(token)
}
