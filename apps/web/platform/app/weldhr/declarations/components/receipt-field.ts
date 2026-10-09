/** Client-side check of a receipt before it is uploaded; the server checks again. */

import {
  HR_DECLARATION_RECEIPT_MAX_BYTES,
  HR_DECLARATION_RECEIPT_TYPES,
} from '@weldsuite/app-api-client/schemas/weldhr';

export const RECEIPT_ACCEPT = HR_DECLARATION_RECEIPT_TYPES.join(',');

/** Why this file cannot be a receipt, or null when it can. */
export function receiptProblem(file: File): 'type' | 'size' | null {
  if (!(HR_DECLARATION_RECEIPT_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > HR_DECLARATION_RECEIPT_MAX_BYTES) return 'size';
  return null;
}

/** "12,50" or "12.50" → 12.5; null unless it is above zero with at most two decimals. */
export function parseAmount(input: string): number | null {
  const normalised = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  const amount = Number(normalised);
  return amount > 0 ? amount : null;
}
