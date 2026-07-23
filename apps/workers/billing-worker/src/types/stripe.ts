/**
 * Minimal Stripe Webhook Types (No SDK Dependency)
 */

export interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: any;
  };
}

export interface StripeCheckoutSession {
  id: string;
  mode: string;
  subscription: string | null;
  customer: string | null;
  metadata: Record<string, string> | null;
  /** 'paid' | 'unpaid' | 'no_payment_required' — relevant for mode='payment'. */
  payment_status?: string;
  payment_intent?: string | { id: string } | null;
  /** Total in the smallest currency unit (cents). */
  amount_total?: number | null;
  currency?: string | null;
  customer_details?: {
    address?: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      postal_code?: string | null;
      country?: string | null;
    } | null;
    name?: string | null;
    email?: string | null;
    tax_ids?: Array<{
      type: string;
      value: string;
    }> | null;
    tax_exempt?: string | null;
  } | null;
}

export interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        product: string;
        recurring?: { interval: string } | null;
      };
      quantity: number;
    }>;
  };
  current_period_start?: number | null;
  current_period_end?: number | null;
  metadata: Record<string, string> | null;
}

export interface StripeInvoice {
  id: string;
  subscription: string | { id: string } | null;
  billing_reason: string | null;
  customer: string | null;
  number: string | null;
  amount_due: number;
  amount_paid: number;
  total: number;
  subtotal?: number;
  tax?: number | null;
  currency: string;
  status: string | null;
  period_start?: number | null;
  period_end?: number | null;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  created?: number | null;
  customer_address?: {
    country?: string | null;
  } | null;
  customer_tax_exempt?: string | null;
  status_transitions?: {
    paid_at?: number | null;
  } | null;
}

export interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string> | null;
}

export interface StripePrice {
  id: string;
  product: string | { id: string } | null;
  unit_amount: number | null;
  currency: string;
  recurring: {
    interval: string;
  } | null;
  metadata: Record<string, string> | null;
}

export interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string; // succeeded, requires_payment_method, requires_action, processing, canceled
  customer: string | null;
  invoice: string | null;
  payment_method: string | null;
  last_payment_error: {
    code: string;
    message: string;
  } | null;
  charges: {
    data: StripeCharge[];
  };
  metadata: Record<string, string> | null;
}

/** Stripe Connect account (webhook payload for `account.updated`). */
export interface StripeConnectAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  metadata?: Record<string, string> | null;
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  payment_intent?: string | { id: string } | null;
  payment_method_details: {
    type: string;
    card?: {
      brand: string;
      last4: string;
    };
    sepa_debit?: {
      last4: string;
    };
    bank_transfer?: Record<string, any>;
  } | null;
  refunded: boolean;
  amount_refunded: number;
}
