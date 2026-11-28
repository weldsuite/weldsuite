/**
 * Which object panel shows the record a WeldBooks row points at, so a
 * reference becomes a chip that stacks that panel instead of text.
 */

import type { ObjectType } from '@/components/object-panel/types';

export interface RecordRef {
  type: ObjectType;
  id: string;
}

/**
 * The panel of the record that posted a journal entry, by the entry's
 * `sourceType`. A source without a panel (a payment, a bank reconciliation,
 * a depreciation run) is not listed: the entry shows its translated name.
 */
const JOURNAL_SOURCE_PANELS: Readonly<Record<string, ObjectType>> = {
  invoice: 'invoice',
  credit_note: 'invoice',
  bill: 'bill',
  bill_credit_note: 'bill',
  bank_transaction: 'bank_transaction',
  bank_deposit: 'deposit',
  fixed_asset: 'fixed_asset',
  payroll: 'payroll_run',
  tax_return: 'vat_return',
  pick_list: 'pick-list',
};

/** The record behind a journal entry's source, or null when it has no panel (or no id). */
export function journalSourceRecord(
  sourceType: string | null | undefined,
  sourceId: string | null | undefined,
): RecordRef | null {
  if (!sourceType || !sourceId) return null;
  const type = JOURNAL_SOURCE_PANELS[sourceType];
  return type ? { type, id: sourceId } : null;
}

/** The panel of a sales-tax or report document row (`invoice`, `credit_note`, `bill`, `journal_entry`, …). */
export function documentRecord(
  documentType: string | null | undefined,
  documentId: string | null | undefined,
): RecordRef | null {
  if (!documentType || !documentId) return null;
  if (
    documentType === 'invoice' ||
    documentType === 'credit_note' ||
    documentType === 'write_off' ||
    documentType === 'bad_debt'
  ) {
    return { type: 'invoice', id: documentId };
  }
  if (documentType === 'bill' || documentType === 'bill_credit_note') return { type: 'bill', id: documentId };
  if (documentType === 'journal_entry') return { type: 'journal_entry', id: documentId };
  return null;
}
