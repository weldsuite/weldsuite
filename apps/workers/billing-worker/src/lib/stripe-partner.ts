/**
 * Stripe calls behind the partner statement invoice (services/partner-billing.ts).
 *
 * Same raw-fetch style as ./stripe.ts. A statement becomes one `send_invoice`
 * invoice on the partner's Stripe customer. The invoice is created first (as a
 * draft that excludes pending invoice items) and the items are attached to it
 * by id, so a retried run can never leave stray pending items that would end
 * up on the next invoice.
 */

import { stripeApiRequest } from './stripe';

const enc = encodeURIComponent;

export interface PartnerStripeInvoice {
  id: string;
  /** draft | open | paid | void | uncollectible */
  status: string | null;
  number?: string | null;
  total?: number;
  amount_due: number;
  currency: string;
  /** Unix seconds. */
  due_date?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  customer?: string | null;
  metadata?: Record<string, string> | null;
}

function addMetadata(body: Record<string, string>, metadata: Record<string, string> | undefined): void {
  for (const [k, v] of Object.entries(metadata ?? {})) body[`metadata[${k}]`] = v;
}

export async function retrievePartnerInvoice(key: string, invoiceId: string): Promise<PartnerStripeInvoice> {
  return stripeApiRequest(key, 'GET', `/v1/invoices/${enc(invoiceId)}`);
}

/** A draft invoice that bills by sending the partner a payment link, on net terms. */
export async function createPartnerDraftInvoice(
  key: string,
  params: {
    customerId: string;
    currency: string;
    daysUntilDue: number;
    description: string;
    metadata: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<PartnerStripeInvoice> {
  const body: Record<string, string> = {
    customer: params.customerId,
    collection_method: 'send_invoice',
    days_until_due: String(params.daysUntilDue),
    currency: params.currency.toLowerCase(),
    auto_advance: 'false',
    pending_invoice_items_behavior: 'exclude',
    description: params.description,
  };
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/invoices', body, { idempotencyKey });
}

/** One line on a draft invoice. `amountCents` is the whole line amount. */
export async function createPartnerInvoiceItem(
  key: string,
  params: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata?: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<{ id: string }> {
  const body: Record<string, string> = {
    customer: params.customerId,
    invoice: params.invoiceId,
    amount: String(params.amountCents),
    currency: params.currency.toLowerCase(),
    description: params.description,
  };
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/invoiceitems', body, { idempotencyKey });
}

export async function finalizePartnerInvoice(
  key: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<PartnerStripeInvoice> {
  return stripeApiRequest(
    key,
    'POST',
    `/v1/invoices/${enc(invoiceId)}/finalize_invoice`,
    { auto_advance: 'false' },
    { idempotencyKey },
  );
}

/** Email the invoice (hosted payment link and PDF) to the customer's email. */
export async function sendPartnerInvoice(
  key: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<PartnerStripeInvoice> {
  return stripeApiRequest(key, 'POST', `/v1/invoices/${enc(invoiceId)}/send`, undefined, { idempotencyKey });
}

/** Drafts are deleted, not voided. */
export async function deletePartnerDraftInvoice(key: string, invoiceId: string): Promise<void> {
  await stripeApiRequest(key, 'DELETE', `/v1/invoices/${enc(invoiceId)}`);
}

export async function voidPartnerInvoice(
  key: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<PartnerStripeInvoice> {
  return stripeApiRequest(key, 'POST', `/v1/invoices/${enc(invoiceId)}/void`, undefined, { idempotencyKey });
}
