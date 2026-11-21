/**
 * The receive dialog's rows: what to prefill, what is valid, and the request
 * body. Pure, so the rules are tested apart from the dialog.
 *
 * The API's rules (the screen checks them first, so a typo never costs a
 * round trip): per line `quantity + rejected` is at most what remains to be
 * received; both are whole numbers of 0 or more; a lot-tracked product needs
 * a lot number for the units it receives.
 */

import type { PurchaseOrderLine, ReceivePurchaseOrderLineInput } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { remainingToReceive } from './po-actions';

export interface ReceiveRow {
  itemId: string;
  productId: string | null;
  name: string;
  sku: string | null;
  remaining: number;
  /** Input text: kept as typed until it is validated. */
  quantity: string;
  rejected: string;
  /** Empty: the warehouse's default location. */
  locationId: string;
  lotNumber: string;
  expiryDate: string;
  trackLots: boolean;
  trackExpiry: boolean;
}

export type ReceiveRowIssue = 'invalid_number' | 'over_receipt' | 'lot_required';

/** Rows for the lines that still have something to receive, each prefilled with what remains. */
export function initialReceiveRows(
  lines: readonly PurchaseOrderLine[],
  tracking: Readonly<Record<string, { trackLots: boolean; trackExpiry: boolean } | undefined>> = {},
): ReceiveRow[] {
  return lines
    .map((line) => ({ line, remaining: remainingToReceive(line) }))
    .filter(({ remaining }) => remaining > 0)
    .map(({ line, remaining }) => {
      const track = line.productId ? tracking[line.productId] : undefined;
      return {
        itemId: line.id,
        productId: line.productId,
        name: line.name,
        sku: line.sku,
        remaining,
        quantity: String(remaining),
        rejected: '0',
        locationId: '',
        lotNumber: '',
        expiryDate: '',
        trackLots: track?.trackLots ?? false,
        trackExpiry: track?.trackExpiry ?? false,
      };
    });
}

/** A whole number of 0 or more from input text; null for anything else (empty counts as 0). */
export function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

export function validateReceiveRow(row: ReceiveRow): ReceiveRowIssue | null {
  const quantity = parseCount(row.quantity);
  const rejected = parseCount(row.rejected);
  if (quantity === null || rejected === null) return 'invalid_number';
  if (quantity + rejected > row.remaining) return 'over_receipt';
  if (quantity > 0 && row.trackLots && row.lotNumber.trim() === '') return 'lot_required';
  return null;
}

/** The lines the request carries: rows where something is received or rejected. */
export function buildReceiveLines(rows: readonly ReceiveRow[]): ReceivePurchaseOrderLineInput[] {
  const lines: ReceivePurchaseOrderLineInput[] = [];
  for (const row of rows) {
    const quantity = parseCount(row.quantity) ?? 0;
    const rejected = parseCount(row.rejected) ?? 0;
    if (quantity === 0 && rejected === 0) continue;
    const line: ReceivePurchaseOrderLineInput = { itemId: row.itemId, quantity };
    if (rejected > 0) line.rejected = rejected;
    if (row.locationId) line.locationId = row.locationId;
    if (row.lotNumber.trim()) line.lotNumber = row.lotNumber.trim();
    if (row.expiryDate) line.expiryDate = row.expiryDate;
    lines.push(line);
  }
  return lines;
}

/** A fresh idempotency key: one per submit attempt, reused if that attempt is retried unchanged. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
