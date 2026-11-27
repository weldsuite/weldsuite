/**
 * WeldBooks "process bank lines" client (phase 2, Rust only: edition feature
 * `books-bank-processing`): booking a line to categories, transfers, private
 * payments, receipts, the one Undo, rule suggestions, payment-difference
 * settings and unapplied credit. Shapes mirror the handlers in
 * `rust/modules/books-banking/src/{bank_processing,rule_suggestions}.rs`,
 * `rust/modules/books/src/accounting_settings.rs` and
 * `rust/modules/books-sales/src/payments.rs`. Every answer is `{ data }`.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { ReconciliationRule } from './weldbooks';

export interface DataEnvelope<T> {
  data: T;
}

// ============================================================================
// Booking a line
// ============================================================================

/** One row of a categorize call. The amount is tax-inclusive. */
export interface CategorizeLineInput {
  accountId: string;
  taxRateId?: string;
  contactId?: string;
  projectId?: string;
  /** Number or numeric string; all rows add up to the bank line's absolute amount. */
  amount: number | string;
  description?: string;
}

export interface CategorizeInput {
  lines: CategorizeLineInput[];
}

export interface CategorizeResult {
  id: string;
  status: 'reconciled';
  reconciliationType: 'manual';
  categoryAccountId: string | null;
  journalEntryId: string | null;
  lines: unknown[];
}

export interface TransferResult {
  id: string;
  status: string;
  reconciliationType: 'transfer';
  categoryAccountId: string | null;
  journalEntryId: string | null;
  counterpart: { id: string; bankAccountId: string; journalEntryId: string | null } | null;
}

export interface PrivateResult {
  id: string;
  status: string;
  reconciliationType: 'private';
  categoryAccountId: string | null;
  journalEntryId: string | null;
}

export interface AttachDocumentResult {
  id: string;
  documentId: string;
  linkedEntityType: 'bank_transaction';
  linkedEntityId: string;
  status: 'linked';
}

export type UndoneKind = 'payment' | 'deposit' | 'category' | 'transfer' | 'private' | 'ignore';

export interface UndoResult {
  id: string;
  status: 'unreconciled';
  undone: UndoneKind;
  automatic: boolean;
  reversedJournalEntryId: string | null;
  voidedPaymentId: string | null;
}

// ============================================================================
// Rules
// ============================================================================

export type RuleSuggestionField = 'counterpartyIban' | 'counterpartyName' | 'direction';

export interface RuleSuggestionCondition {
  field: RuleSuggestionField;
  operator: 'equals';
  value: string;
}

/** A rule pre-filled from how a line was booked: the form's starting point. It is not saved. */
export interface RulePrefill {
  name: string;
  matchMode: 'all';
  conditions: RuleSuggestionCondition[];
  actions: { categoryAccountId: string; taxRateId?: string; contactId?: string };
}

export interface RuleSuggestion extends RulePrefill {
  /** The same counterparty was booked to this category `times` times. */
  evidence: { times: number; categoryAccountId: string };
}

/** What the rule form takes to start from (`Partial<ReconciliationRule>` of a rule that is not saved yet). */
export type RuleFormPrefill = Pick<ReconciliationRule, 'name' | 'matchMode' | 'conditions' | 'actions'>;

// ============================================================================
// Payment differences
// ============================================================================

export interface DifferenceSettings {
  bankCostsAccountId: string | null;
  paymentDiscountAccountId: string | null;
  roundingAccountId: string | null;
  /** The account rounding goes to: the entity's own choice, else the chart's default. */
  effectiveRoundingAccountId: string | null;
  /** A decimal string such as `"1.00"`. */
  roundingCap: string;
}

/** `null` resets a key to the default. */
export interface DifferenceSettingsInput {
  bankCostsAccountId?: string | null;
  paymentDiscountAccountId?: string | null;
  roundingAccountId?: string | null;
  roundingCap?: string | null;
}

// ============================================================================
// Unapplied credit
// ============================================================================

export interface ContactCredit {
  paymentId: string;
  type: string;
  date: string;
  currency: string | null;
  reference: string | null;
  amount: string;
  unallocatedAmount: string;
  bankTransactionId: string | null;
}

export type ApplyPaymentInput = ({ invoiceId: string } | { billId: string }) & { amount: string | number };

export interface ApplyPaymentResult {
  paymentId: string;
  invoiceId?: string;
  billId?: string;
  amount: string;
  unallocatedAmount: string;
}

export const processingApi = {
  categorize: (id: string, data: CategorizeInput) =>
    weldbooksApi.post<DataEnvelope<CategorizeResult>>(`/bank-transactions/${id}/categorize`, data),
  transfer: (id: string, data: { bankAccountId?: string }) =>
    weldbooksApi.post<DataEnvelope<TransferResult>>(`/bank-transactions/${id}/transfer`, data),
  markPrivate: (id: string) => weldbooksApi.post<DataEnvelope<PrivateResult>>(`/bank-transactions/${id}/private`),
  attachDocument: (id: string, documentId: string) =>
    weldbooksApi.post<DataEnvelope<AttachDocumentResult>>(`/bank-transactions/${id}/attach-document`, { documentId }),
  updateNotes: (id: string, notes: string | null) =>
    weldbooksApi.patch<DataEnvelope<unknown>>(`/bank-transactions/${id}`, { notes }),
  undo: (id: string) => weldbooksApi.post<DataEnvelope<UndoResult>>(`/bank-transactions/${id}/undo`),

  ruleSuggestion: (id: string) =>
    weldbooksApi.get<DataEnvelope<RuleSuggestion | null>>(`/bank-transactions/${id}/rule-suggestion`),
  ruleFromTransaction: (id: string) =>
    weldbooksApi.post<DataEnvelope<RulePrefill>>(`/reconciliation-rules/from-transaction/${id}`),

  getDifferenceSettings: () => weldbooksApi.get<DataEnvelope<DifferenceSettings>>('/accounting-settings/differences'),
  updateDifferenceSettings: (data: DifferenceSettingsInput) =>
    weldbooksApi.patch<DataEnvelope<DifferenceSettings>>('/accounting-settings/differences', data),

  listCredits: (contactId: string) =>
    weldbooksApi.get<DataEnvelope<ContactCredit[]>>(`/accounting-contacts/${contactId}/credits`),
  applyPayment: (paymentId: string, data: ApplyPaymentInput) =>
    weldbooksApi.post<DataEnvelope<ApplyPaymentResult>>(`/payments/${paymentId}/apply`, data),
};
