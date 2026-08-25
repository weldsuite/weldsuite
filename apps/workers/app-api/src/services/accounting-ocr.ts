/**
 * Accounting OCR — extract vendor, dates, line items and totals from a
 * scanned invoice or receipt.
 *
 * Rebuilt on `@weldsuite/ai` (Cloudflare AI Gateway) after the agent-worker
 * teardown. A vision-capable model reads the image from R2 and returns
 * structured JSON; the document inbox and the mobile scan flow both consume
 * that result to pre-fill a bill.
 *
 * Credit metering matches mail AI: hard-gate before the call, consume after.
 */

import {
  assertGatewayConfigured,
  createWeldAI,
  generateObject,
  jsonSchema,
  thirdParty,
} from '@weldsuite/ai';
import type { Env } from '../types';
import { assertAiCredits, chargeAiUsage, type AiMetering } from './ai/billing';

export { InsufficientAiCreditsError } from './ai/billing';

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

export class AccountingOcrError extends Error {
  constructor(
    public readonly code: 'AI_NOT_CONFIGURED' | 'AI_REQUEST_FAILED' | 'FILE_NOT_FOUND' | 'UNSUPPORTED_TYPE',
    message: string,
  ) {
    super(message);
    this.name = 'AccountingOcrError';
  }
}

/** Vision model — invoice OCR needs to actually see the page. */
export const OCR_MODEL_ID = thirdParty.anthropic.sonnet;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ocrSchema = jsonSchema<{
  vendor: {
    name: string | null;
    address: string | null;
    taxNumber: string | null;
    kvkNumber: string | null;
    iban: string | null;
    bic: string | null;
  };
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  lineItems: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    taxRate: number | null;
    total: number | null;
  }>;
  subtotal: number | null;
  taxBreakdown: Array<{ rate: number; taxableAmount: number; taxAmount: number }>;
  totalTax: number | null;
  total: number | null;
  paymentReference: string | null;
  iban: string | null;
  confidence: { overall: number; fields: Record<string, number> };
}>({
  type: 'object',
  properties: {
    vendor: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        address: { type: ['string', 'null'] },
        taxNumber: { type: ['string', 'null'] },
        kvkNumber: { type: ['string', 'null'] },
        iban: { type: ['string', 'null'] },
        bic: { type: ['string', 'null'] },
      },
      required: ['name', 'address', 'taxNumber', 'kvkNumber', 'iban', 'bic'],
      additionalProperties: false,
    },
    invoiceNumber: { type: ['string', 'null'] },
    invoiceDate: { type: ['string', 'null'] },
    dueDate: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          unitPrice: { type: ['number', 'null'] },
          taxRate: { type: ['number', 'null'] },
          total: { type: ['number', 'null'] },
        },
        required: ['description', 'quantity', 'unitPrice', 'taxRate', 'total'],
        additionalProperties: false,
      },
    },
    subtotal: { type: ['number', 'null'] },
    taxBreakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rate: { type: 'number' },
          taxableAmount: { type: 'number' },
          taxAmount: { type: 'number' },
        },
        required: ['rate', 'taxableAmount', 'taxAmount'],
        additionalProperties: false,
      },
    },
    totalTax: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    paymentReference: { type: ['string', 'null'] },
    iban: { type: ['string', 'null'] },
    confidence: {
      type: 'object',
      properties: {
        overall: { type: 'number' },
        fields: { type: 'object', additionalProperties: { type: 'number' } },
      },
      required: ['overall', 'fields'],
      additionalProperties: false,
    },
  },
  required: [
    'vendor',
    'invoiceNumber',
    'invoiceDate',
    'dueDate',
    'currency',
    'lineItems',
    'subtotal',
    'taxBreakdown',
    'totalTax',
    'total',
    'paymentReference',
    'iban',
    'confidence',
  ],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `You are an expert bookkeeper extracting data from a photographed purchase invoice or till receipt (often Dutch or English).

Rules:
- vendor.name is the supplier who ISSUED the document, not the customer.
- Dates must be ISO YYYY-MM-DD. Convert Dutch formats like 24-08-2026.
- currency is an ISO 4217 code; default EUR if the symbol is €.
- unitPrice and line total are exclusive of VAT. taxRate is a percentage (21, not 0.21).
- subtotal is exclusive of VAT; total is the amount payable (inclusive).
- taxNumber is a VAT/BTW id (NL…B01). kvkNumber is a Dutch Chamber of Commerce number.
- If a field is not visible or you are unsure, use null (or [] for lists).
- confidence.overall is 0–1 for the extraction as a whole.
- Do not invent line items. If you can only see a total, leave lineItems empty.`;

export interface ProcessDocumentOcrParams {
  fileKey: string;
  mimeType: string | null;
  workspaceId: string;
  userId: string;
  documentId: string;
  metering: AiMetering | null;
}

export async function processDocumentOcr(
  env: Env,
  params: ProcessDocumentOcrParams,
): Promise<OcrResult> {
  const mimeType = normalizeMime(params.mimeType);
  if (!IMAGE_TYPES.has(mimeType)) {
    throw new AccountingOcrError(
      'UNSUPPORTED_TYPE',
      'OCR currently supports JPEG, PNG and WebP images.',
    );
  }

  if (!env.STORAGE) {
    throw new AccountingOcrError('FILE_NOT_FOUND', 'File storage is not configured.');
  }

  const stored = await env.STORAGE.get(params.fileKey);
  if (!stored) {
    throw new AccountingOcrError('FILE_NOT_FOUND', `File not found: ${params.fileKey}`);
  }

  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AccountingOcrError('FILE_NOT_FOUND', 'The uploaded file is empty.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AccountingOcrError(
      'UNSUPPORTED_TYPE',
      'The image is too large to read. Capture it again a bit closer or at lower quality.',
    );
  }

  let ai;
  try {
    assertGatewayConfigured(env);
    ai = createWeldAI(env);
  } catch (err) {
    throw new AccountingOcrError(
      'AI_NOT_CONFIGURED',
      err instanceof Error ? err.message : 'AI gateway is not configured',
    );
  }

  await assertAiCredits(params.metering);

  try {
    const result = await generateObject({
      model: ai.model(OCR_MODEL_ID),
      schema: ocrSchema,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract the invoice / receipt fields from this image.',
            },
            { type: 'image', image: bytes, mediaType: mimeType },
          ],
        },
      ],
    });
    await chargeAiUsage(params.metering, {
      modelId: OCR_MODEL_ID,
      usage: result.usage,
      op: 'accounting-ocr',
      referenceId: params.documentId,
    });
    return normalizeOcrResult(result.object);
  } catch (err) {
    if (err instanceof AccountingOcrError) throw err;
    throw new AccountingOcrError(
      'AI_REQUEST_FAILED',
      err instanceof Error ? err.message : 'OCR request failed',
    );
  }
}

export function normalizeOcrResult(parsed: Record<string, unknown> | null | undefined): OcrResult {
  const raw = (parsed ?? {}) as Record<string, any>;
  const vendor = raw.vendor ?? {};
  return {
    vendor: {
      name: vendor.name ?? null,
      address: vendor.address ?? null,
      taxNumber: vendor.taxNumber ?? null,
      kvkNumber: vendor.kvkNumber ?? null,
      iban: vendor.iban ?? null,
      bic: vendor.bic ?? null,
    },
    invoiceNumber: raw.invoiceNumber ?? null,
    invoiceDate: asIsoDate(raw.invoiceDate),
    dueDate: asIsoDate(raw.dueDate),
    currency: raw.currency ?? 'EUR',
    lineItems: Array.isArray(raw.lineItems)
      ? raw.lineItems.map((item: any) => ({
          description: item.description ?? '',
          quantity: asNumber(item.quantity),
          unitPrice: asNumber(item.unitPrice),
          taxRate: asNumber(item.taxRate),
          total: asNumber(item.total),
        }))
      : [],
    subtotal: asNumber(raw.subtotal),
    taxBreakdown: Array.isArray(raw.taxBreakdown)
      ? raw.taxBreakdown.map((tb: any) => ({
          rate: asNumber(tb.rate) ?? 0,
          taxableAmount: asNumber(tb.taxableAmount) ?? 0,
          taxAmount: asNumber(tb.taxAmount) ?? 0,
        }))
      : [],
    totalTax: asNumber(raw.totalTax),
    total: asNumber(raw.total),
    paymentReference: raw.paymentReference ?? null,
    iban: raw.iban ?? null,
    confidence: {
      overall: asNumber(raw.confidence?.overall) ?? 0,
      fields: raw.confidence?.fields ?? {},
    },
    rawText: raw.rawText ?? null,
  };
}

/** Line items the bill form can consume — synthesises one line when OCR only saw a total. */
export function lineItemsForBill(ocr: OcrResult): Array<{
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string | null;
  sortOrder: number;
}> {
  if (ocr.lineItems.length > 0) {
    return ocr.lineItems.map((li, idx) => ({
      description: li.description || 'Item',
      quantity: String(li.quantity ?? 1),
      unitPrice: String(li.unitPrice ?? 0),
      taxRate: li.taxRate != null ? String(li.taxRate) : null,
      sortOrder: idx,
    }));
  }

  const exclusive = exclusiveAmount(ocr);
  if (exclusive == null) return [];

  return [
    {
      description: ocr.vendor.name || 'Scanned receipt',
      quantity: '1',
      unitPrice: String(round2(exclusive)),
      taxRate: dominantTaxRate(ocr) != null ? String(dominantTaxRate(ocr)) : null,
      sortOrder: 0,
    },
  ];
}

/** Amount exclusive of VAT, for a one-line expense. */
export function exclusiveAmount(ocr: OcrResult): number | null {
  if (ocr.subtotal != null && Number.isFinite(ocr.subtotal)) return ocr.subtotal;
  const fromLines = ocr.lineItems.reduce((sum, li) => {
    if (li.unitPrice == null) return sum;
    return sum + li.unitPrice * (li.quantity ?? 1);
  }, 0);
  if (fromLines > 0) return fromLines;
  if (ocr.total == null || !Number.isFinite(ocr.total)) return null;
  const rate = dominantTaxRate(ocr);
  if (rate == null || rate <= 0) return ocr.total;
  return ocr.total / (1 + rate / 100);
}

export function dominantTaxRate(ocr: OcrResult): number | null {
  if (ocr.taxBreakdown[0]?.rate != null) return ocr.taxBreakdown[0].rate;
  const fromLine = ocr.lineItems.find((li) => li.taxRate != null)?.taxRate;
  return fromLine ?? null;
}

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

function normalizeMime(mime: string | null): string {
  const value = (mime || 'image/jpeg').toLowerCase();
  if (value === 'image/jpg') return 'image/jpeg';
  return value;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const dutch = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dutch) {
    const [, d, m, y] = dutch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return trimmed;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
