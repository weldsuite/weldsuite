/**
 * Copy a Stripe invoice's PDF into R2 so WeldBooks shows it and the Moneybird
 * push can attach it. Soft-fail and budget-aware, like the Moneybird
 * attachment copy: a missing PDF never fails the structured import.
 */

import type { StripeClient } from '@weldsuite/connectors';

export const STRIPE_PDF_DOWNLOAD_BUDGET = 30;

export interface StripeInvoicePdfContext {
  client: StripeClient;
  storage: R2Bucket;
  workspaceId: string;
  budget: { remaining: number };
}

/** Storage keys for `invoices.attachmentKeys`, or null when the budget ran out (retry later). */
export async function storeStripeInvoicePdf(
  ctx: StripeInvoicePdfContext,
  invoice: Record<string, unknown>,
): Promise<string[] | null> {
  const id = typeof invoice.id === 'string' ? invoice.id : null;
  const url = typeof invoice.invoice_pdf === 'string' ? invoice.invoice_pdf : null;
  if (!id || !url) return [];
  if (ctx.budget.remaining <= 0) return null;
  ctx.budget.remaining -= 1;

  try {
    const pdf = await ctx.client.downloadInvoicePdf(url);
    if (!pdf) return [];
    const account = ctx.client.accountId ?? 'account';
    const key = `workspaces/${ctx.workspaceId}/connectors/stripe/${account}/stripe_invoice/${id}/invoice.pdf`;
    await ctx.storage.put(key, pdf.bytes, { httpMetadata: { contentType: pdf.contentType } });
    return [key];
  } catch (err) {
    console.warn(`[connectors/stripe-invoice-pdf] ${id}:`, err instanceof Error ? err.message : err);
    return [];
  }
}
