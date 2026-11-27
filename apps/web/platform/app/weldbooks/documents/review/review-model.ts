/**
 * The review screen's sums and rules: the lines of a document and how they
 * compare with its total, what "Paid with" offers for each kind, what is still
 * missing before the document can be booked, and the `POST /book` body. Pure
 * functions, in whole cents, so the screen and the request agree to the cent.
 */
import { fromCents, toCents } from '@/lib/weldbooks/bank-link-math';
import type {
  BankCandidate,
  BookDocumentInput,
  BookKind,
  DocumentPrefill,
  ContactBookingDefaults,
  InboxDocument,
  PaidWith,
  PrefillLine,
} from '@/lib/api/domains/weldbooks-receipts';

/** What the person says a document is; "not for the books" rejects it. */
export type ReviewKind = BookKind | 'not_for_books';

export const REVIEW_KINDS: readonly ReviewKind[] = ['purchase_invoice', 'receipt', 'credit_note', 'not_for_books'];

export interface ReviewLine {
  /** Stable id for React keys; never sent. */
  key: string;
  description: string;
  accountId: string;
  taxRateId: string;
  projectId: string;
  /** As typed, tax-inclusive. */
  amount: string;
}

/** How the document was paid, as the radio list says it. */
export type PaidChoice =
  | { type: 'bank_transaction'; bankTransactionId: string }
  | { type: 'none' }
  | { type: 'cash' }
  | { type: 'private' };

export interface ReviewState {
  kind: BookKind;
  contactId: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  currency: string;
  lines: ReviewLine[];
  paid: PaidChoice;
}

export type ReviewProblem = 'noSupplier' | 'noDate' | 'noLines' | 'noCategory' | 'badAmount' | 'noBankLine';

let counter = 0;

export function newReviewLine(defaults: Partial<ReviewLine> = {}): ReviewLine {
  counter += 1;
  return { key: `line-${counter}`, description: '', accountId: '', taxRateId: '', projectId: '', amount: '', ...defaults };
}

/** A number as the amount field shows it: no trailing zeros beyond cents. */
function amountText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return fromCents(Math.round(value * 100));
}

/** The lines the prefill reads from the document (gross amounts, history for category, VAT and project). */
export function linesFromPrefill(lines: readonly PrefillLine[]): ReviewLine[] {
  return lines.map((line) =>
    newReviewLine({
      description: line.description ?? '',
      accountId: line.accountId ?? '',
      taxRateId: line.taxRateId ?? '',
      projectId: line.projectId ?? '',
      amount: amountText(line.amount),
    }),
  );
}

/** Whether a kind can be paid with a bank line, cash or privately (a credit note is only ever "not paid yet"). */
export function canPayWith(kind: BookKind): boolean {
  return kind !== 'credit_note';
}

/**
 * What "Paid with" starts on: the sure bank line when there is one, else what
 * the scan said (cash or private), else not paid yet. A credit note is never paid.
 */
export function initialPaidChoice(
  kind: BookKind,
  prefill: Pick<DocumentPrefill, 'paidWith'> | null | undefined,
  candidates: readonly BankCandidate[],
): PaidChoice {
  if (!canPayWith(kind)) return { type: 'none' };
  const sure = candidates.find((candidate) => candidate.sure);
  if (sure) return { type: 'bank_transaction', bankTransactionId: sure.id };
  const suggested = prefill?.paidWith?.type;
  if (suggested === 'cash') return { type: 'cash' };
  if (suggested === 'private') return { type: 'private' };
  return { type: 'none' };
}

/** The form's starting values from the prefill; the pieces the prefill lacks stay empty. */
export function initialReviewState(prefill: DocumentPrefill | null | undefined, today: string): ReviewState {
  const lines = prefill ? linesFromPrefill(prefill.lines) : [];
  const kind: BookKind = prefill?.kind ?? 'purchase_invoice';
  return {
    kind,
    contactId: prefill?.contactId ?? '',
    invoiceNumber: prefill?.invoiceNumber ?? '',
    date: prefill?.date ?? today,
    dueDate: prefill?.dueDate ?? '',
    currency: prefill?.currency ?? '',
    lines: lines.length > 0 ? lines : [newReviewLine()],
    paid: initialPaidChoice(kind, prefill, []),
  };
}

export interface TotalCheck {
  /** The lines added up, in cents (lines that cannot be read count as zero). */
  sumCents: number;
  /** The document's own total in cents, or null when it shows none. */
  totalCents: number | null;
  /** Lines less document, or null with no total. */
  differenceCents: number | null;
  matches: boolean;
}

/** The lines against the document's total; they must agree to the cent before the document is booked. */
export function totalCheck(lines: readonly ReviewLine[], documentTotal: number | null | undefined): TotalCheck {
  const sumCents = lines.reduce((sum, line) => {
    const cents = toCents(line.amount);
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
  const totalCents = documentTotal === null || documentTotal === undefined ? null : Math.round(documentTotal * 100);
  const differenceCents = totalCents === null ? null : sumCents - totalCents;
  return { sumCents, totalCents, differenceCents, matches: differenceCents === 0 };
}

/** What is missing before the document can be booked, or null when it can. */
export function reviewProblem(state: ReviewState): ReviewProblem | null {
  if (!state.contactId) return 'noSupplier';
  if (!state.date) return 'noDate';
  if (state.lines.length === 0) return 'noLines';
  for (const line of state.lines) {
    const cents = toCents(line.amount);
    // A credit note's amounts are positive too: the kind says which way it goes.
    if (!Number.isFinite(cents) || cents <= 0) return 'badAmount';
  }
  if (state.lines.some((line) => !line.accountId)) return 'noCategory';
  if (state.paid.type === 'bank_transaction' && !state.paid.bankTransactionId) return 'noBankLine';
  return null;
}

/** The `paidWith` of the request; "not paid yet" and a credit note send none, so a sure bank line may still link itself. */
export function paidWithOf(kind: BookKind, paid: PaidChoice): PaidWith | undefined {
  if (!canPayWith(kind)) return undefined;
  switch (paid.type) {
    case 'bank_transaction':
      return { type: 'bank_transaction', bankTransactionId: paid.bankTransactionId };
    case 'cash':
      return { type: 'cash' };
    case 'private':
      return { type: 'private' };
    case 'none':
      return { type: 'card_unmatched' };
  }
}

/** The request body for a state that passed `reviewProblem`. Empty optional values are left out. */
export function buildBookInput(state: ReviewState): BookDocumentInput {
  const input: BookDocumentInput = {
    kind: state.kind,
    contactId: state.contactId,
    date: state.date,
    lines: state.lines.map((line, index) => ({
      description: line.description.trim() || `${index + 1}`,
      accountId: line.accountId,
      amount: Number(fromCents(toCents(line.amount))),
      ...(line.taxRateId ? { taxRateId: line.taxRateId } : {}),
      ...(line.projectId ? { projectId: line.projectId } : {}),
    })),
  };
  if (state.invoiceNumber.trim()) input.invoiceNumber = state.invoiceNumber.trim();
  if (state.dueDate) input.dueDate = state.dueDate;
  if (state.currency) input.currency = state.currency;
  const paidWith = paidWithOf(state.kind, state.paid);
  if (paidWith) input.paidWith = paidWith;
  return input;
}

/** The overrides that make the bank-line search follow what is typed (amount, date, supplier, number). */
export function candidateOverrides(state: ReviewState): { amount?: string; date?: string; contactId?: string; invoiceNumber?: string } {
  const cents = state.lines.reduce((sum, line) => {
    const value = toCents(line.amount);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  return {
    ...(cents > 0 ? { amount: fromCents(cents) } : {}),
    ...(state.date ? { date: state.date } : {}),
    ...(state.contactId ? { contactId: state.contactId } : {}),
    ...(state.invoiceNumber.trim() ? { invoiceNumber: state.invoiceNumber.trim() } : {}),
  };
}

export type ReasonKey = 'exactAmount' | 'closeAmount' | 'window' | 'iban' | 'number' | 'name';

/** The server's reasons (English text) as copy keys; one it does not know yet is left out, never shown raw. */
export function reasonKeys(reasons: readonly string[]): ReasonKey[] {
  const keys: ReasonKey[] = [];
  for (const reason of reasons) {
    let key: ReasonKey | null = null;
    if (reason === 'exact amount match') key = 'exactAmount';
    else if (reason === 'close amount match') key = 'closeAmount';
    else if (reason === 'inside the payment window') key = 'window';
    else if (reason === 'counterparty IBAN matches the supplier') key = 'iban';
    else if (reason === 'document number in the description') key = 'number';
    else if (reason.endsWith(' the supplier')) key = 'name';
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Statuses of a document that still wait to be checked. */
const TO_CHECK: ReadonlySet<string> = new Set(['processed', 'review', 'pending', 'failed']);

/**
 * The document to open after `currentId`: the next one that still waits to be
 * checked, after the current one in list order, then from the top. Null when
 * nothing else is left.
 */
export function nextDocumentId(
  documents: ReadonlyArray<Pick<InboxDocument, 'id' | 'status'>>,
  currentId: string,
  skip: ReadonlySet<string> = new Set(),
): string | null {
  const open = documents.filter((doc) => doc.id !== currentId && !skip.has(doc.id) && TO_CHECK.has(doc.status));
  if (open.length === 0) return null;
  const index = documents.findIndex((doc) => doc.id === currentId);
  const after = index >= 0 ? open.find((doc) => documents.indexOf(doc) > index) : undefined;
  return (after ?? open[0]).id;
}

/** Whether Enter in `target` belongs to a field, a button or a list, not to "Save and next". */
export function isEnterOwnedBy(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('input, textarea, select, button, a[href], [role="combobox"], [role="listbox"], [role="radio"], [role="option"], [role="dialog"], [role="alertdialog"]')) return true;
  return false;
}

/**
 * A supplier's usual category, VAT rate and project, put on the lines that
 * have none yet. Whatever was typed or read from the document stays.
 */
export function applyBookingDefaults(
  lines: readonly ReviewLine[],
  defaults: Pick<ContactBookingDefaults, 'account' | 'taxRate' | 'project'> | null | undefined,
): ReviewLine[] {
  if (!defaults) return [...lines];
  return lines.map((line) => ({
    ...line,
    accountId: line.accountId || defaults.account?.accountId || '',
    taxRateId: line.taxRateId || defaults.taxRate?.taxRateId || '',
    projectId: line.projectId || defaults.project?.projectId || '',
  }));
}
