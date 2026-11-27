/**
 * "Pay bills": which bills can be picked, the running total, the masked IBAN,
 * the status a batch shows and the words of a refusal. Pure functions, in whole
 * cents.
 */
import { fromCents, toCents } from '@/lib/weldbooks/bank-link-math';
import {
  BATCH_ERROR_CODES,
  type BatchErrorCode,
  type BatchStatus,
  type PaymentBatch,
} from '@/lib/api/domains/weldbooks-receipts';

/** `NL91 •••• 4300`: enough to recognise the account, not enough to copy it from the screen. */
export function maskIban(iban: string | null | undefined): string {
  const compact = (iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (compact.length < 9) return compact;
  return `${compact.slice(0, 4)} •••• ${compact.slice(-4)}`;
}

/** The amounts of the picked bills added up, as a decimal string. */
export function selectedTotal(bills: ReadonlyArray<{ id: string; balanceDue: string | null }>, selected: ReadonlySet<string>): string {
  let cents = 0;
  for (const bill of bills) {
    if (!selected.has(bill.id)) continue;
    const value = toCents(bill.balanceDue ?? '0');
    if (Number.isFinite(value)) cents += value;
  }
  return fromCents(cents);
}

/** What a batch shows: cancelled and exported are the server's; completed is worked out when every bill in it is paid. */
export function batchStatus(batch: Pick<PaymentBatch, 'status' | 'billCount' | 'paidBillCount'>): BatchStatus {
  if (batch.status === 'cancelled') return 'cancelled';
  if (batch.billCount > 0 && batch.paidBillCount >= batch.billCount) return 'completed';
  return 'exported';
}

/** A bill the file may hold: it is not already in an exported file waiting for its bank line. */
export function isSelectable(billId: string, pending: ReadonlyMap<string, unknown>): boolean {
  return !pending.has(billId);
}

/** The server's error code of a refused request, or null for anything else. */
export function batchErrorCode(error: unknown): BatchErrorCode | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' && (BATCH_ERROR_CODES as readonly string[]).includes(code) ? (code as BatchErrorCode) : null;
}

/** The refusal in plain words; a code this build does not know gets the general sentence, never the raw code. */
export function batchErrorMessage(
  error: unknown,
  copy: Readonly<Record<BatchErrorCode, string> & { fallback: string }>,
): string {
  const code = batchErrorCode(error);
  return code ? copy[code] : copy.fallback;
}

/** The held reason in words, or the server's own sentence for a code this build does not know. */
export function heldMessage(held: { code: string; message: string }, copy: Readonly<Record<string, string>>): string {
  return copy[held.code] ?? held.message;
}

/** Whether the picks can be made into a batch (something picked, a bank account, a date). */
export function canCreateBatch(input: { selected: number; bankAccountId: string; executionDate: string }): boolean {
  return input.selected > 0 && input.bankAccountId !== '' && /^\d{4}-\d{2}-\d{2}$/.test(input.executionDate);
}

/** A file name for the download when the server gave none. */
export function batchFileName(batch: Pick<PaymentBatch, 'fileName' | 'executionDate'>): string {
  return batch.fileName?.trim() || `sepa-${batch.executionDate}.xml`;
}
