/**
 * Accounting OCR Service — STUBBED.
 *
 * AI has been physically removed from WeldSuite. This used to call Claude
 * Sonnet 4.6 via Cloudflare AI Gateway to extract structured data from Dutch
 * invoices/receipts. `processDocumentOcr` is now a no-op: it logs a warning
 * and returns an empty `OcrResult` (all fields null, confidence 0) instead of
 * touching R2, the AI Gateway, or credits. The caller
 * (`routes/accounting-documents/index.ts`) already tolerates this — it just
 * marks the document `processed` with an empty result instead of a populated
 * one, and `matchVendorToContact` below no-ops gracefully on empty fields.
 */

import type { Env } from '../types';
import { InsufficientCreditsError } from './ai';

export { InsufficientCreditsError };

// ============================================================================
// Types
// ============================================================================

export interface OcrVendor {
  name: string | null;
  address: string | null;
  taxNumber: string | null;
  kvkNumber: string | null;
  iban: string | null;
  bic: string | null;
}

export interface OcrLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  taxRate: number | null;
  total: number | null;
}

export interface OcrTaxBreakdown {
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

export interface OcrResult {
  vendor: OcrVendor;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  lineItems: OcrLineItem[];
  subtotal: number | null;
  taxBreakdown: OcrTaxBreakdown[];
  totalTax: number | null;
  total: number | null;
  paymentReference: string | null;
  iban: string | null;
  confidence: {
    overall: number;
    fields: Record<string, number>;
  };
  rawText: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Retained for the caller (`accounting-documents/index.ts`), which stamps
 *  this onto the document row's `ocrModel` column for historical records.
 *  No model is actually invoked anymore. */
export const OCR_MODEL_ID = 'anthropic/claude-sonnet-4-6';

// ============================================================================
// Main OCR function — STUBBED
// ============================================================================

export interface ProcessDocumentOcrParams {
  fileKey: string;
  mimeType: string | null;
  workspaceId: string;
  userId: string;
  documentId: string;
  /**
   * Tenant Drizzle client — unused now that OCR is a no-op, kept on the
   * signature so the caller doesn't need to change.
   */
  tenantDb: unknown;
}

/**
 * AI is currently unavailable. Returns an empty `OcrResult` (all fields
 * null, confidence 0) instead of extracting anything — no R2 fetch, no AI
 * Gateway call, no credit consumption. The caller marks the document
 * `processed` with this empty result rather than surfacing an error, and
 * `matchVendorToContact` below already no-ops gracefully when every
 * candidate field is empty.
 */
export async function processDocumentOcr(
  _env: Env,
  params: ProcessDocumentOcrParams,
): Promise<OcrResult> {
  console.warn(
    `[ai] AI is currently unavailable — skipping OCR for document ${params.documentId}`,
  );
  return normalizeOcrResult({});
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeOcrResult(parsed: any): OcrResult {
  return {
    vendor: {
      name: parsed.vendor?.name ?? null,
      address: parsed.vendor?.address ?? null,
      taxNumber: parsed.vendor?.taxNumber ?? null,
      kvkNumber: parsed.vendor?.kvkNumber ?? null,
      iban: parsed.vendor?.iban ?? null,
      bic: parsed.vendor?.bic ?? null,
    },
    invoiceNumber: parsed.invoiceNumber ?? null,
    invoiceDate: parsed.invoiceDate ?? null,
    dueDate: parsed.dueDate ?? null,
    currency: parsed.currency ?? 'EUR',
    lineItems: Array.isArray(parsed.lineItems)
      ? parsed.lineItems.map((item: any) => ({
          description: item.description ?? '',
          quantity: item.quantity ?? null,
          unitPrice: item.unitPrice ?? null,
          taxRate: item.taxRate ?? null,
          total: item.total ?? null,
        }))
      : [],
    subtotal: parsed.subtotal ?? null,
    taxBreakdown: Array.isArray(parsed.taxBreakdown)
      ? parsed.taxBreakdown.map((tb: any) => ({
          rate: tb.rate ?? 0,
          taxableAmount: tb.taxableAmount ?? 0,
          taxAmount: tb.taxAmount ?? 0,
        }))
      : [],
    totalTax: parsed.totalTax ?? null,
    total: parsed.total ?? null,
    paymentReference: parsed.paymentReference ?? null,
    iban: parsed.iban ?? null,
    confidence: {
      overall: parsed.confidence?.overall ?? 0,
      fields: parsed.confidence?.fields ?? {},
    },
    rawText: parsed.rawText ?? null,
  };
}

// ============================================================================
// Contact matching
// ============================================================================

/**
 * Try to match the OCR vendor to an existing accounting contact.
 * Matches by: taxNumber (BTW-nummer), IBAN, or fuzzy name match.
 */
export async function matchVendorToContact(
  db: any,
  schema: any,
  ocrResult: OcrResult,
): Promise<string | null> {
  const { parties } = schema;
  const { eq, or, and, isNull, ilike } = await import('drizzle-orm');

  const conditions: any[] = [];

  if (ocrResult.vendor.taxNumber) {
    conditions.push(eq(parties.taxNumber, ocrResult.vendor.taxNumber));
  }

  if (ocrResult.vendor.iban || ocrResult.iban) {
    const iban = ocrResult.vendor.iban || ocrResult.iban;
    conditions.push(eq(parties.iban, iban));
  }

  if (ocrResult.vendor.name) {
    conditions.push(ilike(parties.name, `%${ocrResult.vendor.name}%`));
  }

  if (conditions.length === 0) return null;

  const matches = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(or(...conditions), isNull(parties.deletedAt)))
    .limit(1);

  return matches[0]?.id ?? null;
}
