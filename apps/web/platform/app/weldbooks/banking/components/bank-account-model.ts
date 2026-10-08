/**
 * Bank account form model: which ledger accounts suit an account type, what
 * the form's values are worth, and the request they turn into. US entities
 * get an account type, routing and account number; every other entity keeps
 * the IBAN / BIC form.
 */
import type { Account } from '@/lib/api/domains/weldbooks';
import {
  isLiabilityAccountType,
  type BankAccountType,
  type SaveBankAccountInput,
} from '@/lib/api/domains/weldbooks-banking';
import { normalizeAccountNumber, routingNumberProblem } from './routing-number';

/** Select value for "let WeldBooks create the ledger account". */
export const CREATE_LEDGER_ACCOUNT = '__create__';
/** Select value for "no ledger account yet". */
export const NO_LEDGER_ACCOUNT = '__none__';

export interface BankAccountFormValues {
  name: string;
  accountType: BankAccountType;
  iban: string;
  bic: string;
  bankName: string;
  accountHolderName: string;
  currency: string;
  /** An account id, `CREATE_LEDGER_ACCOUNT` or `NO_LEDGER_ACCOUNT`. */
  ledgerAccountId: string;
  isDefault: boolean;
  autoReconcile: boolean;
  routingNumber: string;
  /** A new account number; empty keeps the stored one. */
  accountNumber: string;
  /** Edit only: clear the stored account number. */
  removeAccountNumber: boolean;
  nextCheckNumber: string;
}

export type BankAccountFormProblem =
  | 'name'
  | 'routingFormat'
  | 'routingChecksum'
  | 'accountNumber'
  | 'nextCheckNumber';

/** Ledger accounts a bank account of this type can sit on: a liability for cards and lines of credit, else a bank or cash asset. */
export function ledgerAccountsFor(accounts: readonly Account[], accountType: BankAccountType | null): Account[] {
  const liability = isLiabilityAccountType(accountType);
  return accounts
    .filter((a) => a.isActive !== false)
    .filter((a) => (liability ? a.type === 'liability' : a.type === 'asset' && (a.subtype === 'bank' || a.subtype === 'cash')))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/** A credit card has no routing number or checks. */
export function hasRoutingNumber(accountType: BankAccountType): boolean {
  return accountType !== 'credit_card';
}

export function bankAccountProblems(values: BankAccountFormValues, options: { isUs: boolean }): BankAccountFormProblem[] {
  const problems: BankAccountFormProblem[] = [];
  if (!values.name.trim()) problems.push('name');
  if (!options.isUs) return problems;

  if (hasRoutingNumber(values.accountType)) {
    const routing = routingNumberProblem(values.routingNumber);
    if (routing === 'format') problems.push('routingFormat');
    if (routing === 'checksum') problems.push('routingChecksum');
  }
  if (values.accountNumber.trim() && !normalizeAccountNumber(values.accountNumber)) problems.push('accountNumber');
  const next = values.nextCheckNumber.trim();
  if (next && !/^\d{1,9}$/.test(next)) problems.push('nextCheckNumber');
  return problems;
}

/**
 * The request for the form's values. For a US entity: the account type, the
 * routing and account number and the next check number go along, and a ledger
 * account is created unless one is chosen. Other entities send the IBAN form.
 */
export function buildBankAccountPayload(
  values: BankAccountFormValues,
  options: { isUs: boolean; isEdit: boolean },
): SaveBankAccountInput {
  const base: SaveBankAccountInput = {
    name: values.name.trim(),
    iban: values.iban || undefined,
    bic: values.bic || undefined,
    bankName: values.bankName.trim() || undefined,
    accountHolderName: values.accountHolderName.trim() || undefined,
    currency: values.currency,
    isDefault: values.isDefault,
    autoReconcile: values.autoReconcile,
  };

  if (!options.isUs) {
    return {
      ...base,
      ledgerAccountId:
        values.ledgerAccountId && values.ledgerAccountId !== NO_LEDGER_ACCOUNT && values.ledgerAccountId !== CREATE_LEDGER_ACCOUNT
          ? values.ledgerAccountId
          : undefined,
    };
  }

  const { iban: _iban, bic: _bic, ...us } = base;
  const routing = hasRoutingNumber(values.accountType) ? values.routingNumber.trim() : '';
  const nextCheck = hasRoutingNumber(values.accountType) ? Number.parseInt(values.nextCheckNumber, 10) : Number.NaN;
  const accountNumber = values.accountNumber.trim() ? normalizeAccountNumber(values.accountNumber) : null;
  const chosenLedger =
    values.ledgerAccountId !== CREATE_LEDGER_ACCOUNT && values.ledgerAccountId !== NO_LEDGER_ACCOUNT ? values.ledgerAccountId : '';

  const payload: SaveBankAccountInput = {
    ...us,
    accountType: values.accountType,
    ...(chosenLedger ? { ledgerAccountId: chosenLedger } : {}),
    ...(Number.isFinite(nextCheck) && nextCheck > 0 ? { nextCheckNumber: nextCheck } : {}),
  };

  if (options.isEdit) {
    payload.routingNumber = routing || null;
    if (accountNumber) payload.accountNumber = accountNumber;
    else if (values.removeAccountNumber) payload.accountNumber = null;
    return payload;
  }

  if (routing) payload.routingNumber = routing;
  if (accountNumber) payload.accountNumber = accountNumber;
  if (!chosenLedger && values.ledgerAccountId === NO_LEDGER_ACCOUNT) payload.createLedgerAccount = false;
  return payload;
}
