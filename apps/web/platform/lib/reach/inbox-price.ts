import {
  WELDREACH_INBOX_CURRENCY,
  WELDREACH_INBOX_EU_CURRENCY,
  WELDREACH_INBOX_EU_PRICE_CENTS,
  WELDREACH_INBOX_PRICE_CENTS,
} from '@weldsuite/app-api-client/schemas/reach';
import { billingProvider } from '@/lib/edition';

/** What one WeldReach inbox costs per month, and how it is billed. */
export interface InboxPrice {
  cents: number;
  currency: string;
  /**
   * On the plan's Mollie charge, before VAT (the EU edition): an inbox added
   * mid-month pays the rest of the month, and a paid plan is required. Off,
   * Stripe bills inboxes on their own (Global).
   */
  withPlan: boolean;
}

export function inboxPrice(): InboxPrice {
  if (billingProvider() === 'mollie') {
    return { cents: WELDREACH_INBOX_EU_PRICE_CENTS, currency: WELDREACH_INBOX_EU_CURRENCY, withPlan: true };
  }
  return { cents: WELDREACH_INBOX_PRICE_CENTS, currency: WELDREACH_INBOX_CURRENCY, withPlan: false };
}
