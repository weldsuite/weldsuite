/**
 * Pure helpers for Settings › Billing: the billing-details form model and how
 * it maps to `PUT /api/workspace-settings`, plus the page's currency and
 * subscription rules. Kept out of the components so they can be unit tested.
 */

import type { BillingSubscriptionResponse } from '@/lib/api/domains/billing';

/** The billing-details form, every field a string (empty = not set). */
export interface BillingDetails {
  email: string;
  company: string;
  addressLine1: string;
  addressLine2: string;
  country: string;
  city: string;
  postalCode: string;
  state: string;
  vatNumber: string;
}

/** The subset of the `workspace_settings` row the billing details read. */
export interface WorkspaceBillingSettings {
  email?: string | null;
  legalName?: string | null;
  tradingName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  country?: string | null;
  city?: string | null;
  postalCode?: string | null;
  state?: string | null;
  vatNumber?: string | null;
}

export const EMPTY_BILLING_DETAILS: BillingDetails = {
  email: '',
  company: '',
  addressLine1: '',
  addressLine2: '',
  country: '',
  city: '',
  postalCode: '',
  state: '',
  vatNumber: '',
};

/** The persisted settings row as billing details (the same columns Business settings edits). */
export function billingDetailsFromSettings(ws: WorkspaceBillingSettings | null | undefined): BillingDetails {
  if (!ws) return EMPTY_BILLING_DETAILS;
  return {
    email: ws.email || '',
    company: ws.legalName || ws.tradingName || '',
    addressLine1: ws.addressLine1 || '',
    addressLine2: ws.addressLine2 || '',
    country: ws.country || '',
    city: ws.city || '',
    postalCode: ws.postalCode || '',
    state: ws.state || '',
    vatNumber: ws.vatNumber || '',
  };
}

/**
 * The flat `PUT /api/workspace-settings` body for the billing details. Optional
 * fields left empty are sent as null so they are cleared, as Business settings
 * does.
 */
export function toBillingDetailsPayload(values: BillingDetails) {
  const optional = (value: string) => value.trim() || null;
  return {
    email: values.email.trim(),
    legalName: values.company.trim(),
    addressLine1: values.addressLine1.trim(),
    addressLine2: optional(values.addressLine2),
    country: values.country,
    city: values.city.trim(),
    postalCode: values.postalCode.trim(),
    state: optional(values.state),
    vatNumber: optional(values.vatNumber),
  };
}

/** One line for the Billing details card: address line 1, city, country. */
export function formatBillingAddress(details: Pick<BillingDetails, 'addressLine1' | 'city' | 'country'>): string {
  if (!details.addressLine1) return '';
  return [details.addressLine1, details.city, details.country].filter(Boolean).join(', ');
}

/**
 * An amount in minor units (cents) as currency, in the UI language: English
 * shows `$0.00`, Dutch `US$ 0,00`.
 */
export function formatBillingAmount(amountInCents: number, currency: string | null | undefined, language: string): string {
  const code = (currency || 'eur').toUpperCase();
  try {
    return new Intl.NumberFormat(language, { style: 'currency', currency: code }).format(amountInCents / 100);
  } catch {
    // An unknown currency code or locale: still show the amount.
    return `${(amountInCents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * True when the workspace pays for a Stripe subscription, which is the only
 * thing "Cancel subscription" / "Reactivate subscription" can act on. The Free
 * plan (no Stripe subscription, no renewal date) has nothing to cancel.
 */
export function hasPaidSubscription(subscription: BillingSubscriptionResponse | null | undefined): boolean {
  if (!subscription || subscription.status !== 'active') return false;
  if (subscription.planSlug === 'free') return false;
  return Boolean(subscription.stripeSubscriptionId);
}
