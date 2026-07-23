import { z } from 'zod';

// ============================================================================
// Parties — the operational/financial counterparty wrapper.
//
// After the Companies + People refactor, a Party row is a thin pointer that
// says "this counterparty is either a Company or a Person" and carries the
// commercial fields shared by both kinds (billing address, payment terms,
// credit limit, currency, ledger account defaults).
//
// Transactional artifacts (invoices, orders, tickets, meetings, deals)
// reference a `counterpartyId` → `parties.id`. The party dereferences to the
// underlying Company OR Person for identity.
// ============================================================================

export const partyKind = z.enum(['company', 'person']);

const addressSchema = z
  .object({
    street: z.string().optional(),
    houseNumber: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    province: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

/**
 * Updating a party only touches commercial-relationship fields. Identity
 * fields (name, email, industry, title) are mutated through the Company /
 * Person routes, not here.
 */
export const updatePartySchema = z.object({
  billingAddress: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),
  billingEmail: z.string().email().optional().or(z.literal('')),
  billingPhone: z.string().max(50).optional(),
  currency: z.string().length(3).optional(),
  paymentTerms: z.string().max(50).optional(),
  taxExempt: z.boolean().optional(),
  creditLimit: z
    .object({ amount: z.number(), currency: z.string().length(3) })
    .optional(),
  priceListId: z.string().nullish(),

  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  defaultRevenueAccountId: z.string().nullish(),
  defaultExpenseAccountId: z.string().nullish(),

  ifVersion: z.number().int().positive().optional(),
});

export const listPartiesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  kind: partyKind.optional(),
  search: z.string().optional(),
});

export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
export type ListPartiesQuery = z.infer<typeof listPartiesQuery>;
export type PartyKind = z.infer<typeof partyKind>;

export interface Party {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;

  kind: PartyKind;
  companyId?: string | null;
  personId?: string | null;
  /** Denormalised from the wrapped Company / Person. */
  displayName: string;

  billingAddress?: Record<string, unknown> | null;
  shippingAddress?: Record<string, unknown> | null;
  billingEmail?: string | null;
  billingPhone?: string | null;

  currency?: string | null;
  paymentTerms?: string | null;
  taxExempt?: boolean | null;
  creditLimit?: { amount: number; currency: string } | null;
  priceListId?: string | null;

  iban?: string | null;
  bic?: string | null;
  defaultRevenueAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  outstandingBalance?: string | null;

  lifetimeValue?: { amount: number; currency: string } | null;
  totalRevenue?: { amount: number; currency: string } | null;
  totalOrders?: number | null;
  totalSpent?: { amount: number; currency: string } | null;
  firstOrderAt?: string | null;
  lastOrderAt?: string | null;
  totalOpportunities?: number | null;
  wonOpportunities?: number | null;
  averageDealSize?: { amount: number; currency: string } | null;

  /** Accounting role — distinct from CRM customer/supplier status flags. */
  role: 'customer' | 'supplier' | 'both' | 'none' | string;

  partyCode?: string | null;
}

/**
 * Party with the wrapped identity expanded — what most consumers actually
 * want when they dereference a counterpartyId.
 */
export interface PartyWithIdentity extends Party {
  company?: {
    id: string;
    name: string;
    tradingName?: string | null;
    displayName: string;
    industry?: string | null;
    website?: string | null;
    email?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
  } | null;
  person?: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    displayName: string;
    title?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null;
}
