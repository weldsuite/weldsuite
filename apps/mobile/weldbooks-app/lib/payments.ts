/**
 * Payment methods and where a payment lands, per jurisdiction.
 *
 * A US business takes checks and ACH and wires: a received check or cash goes
 * to Undeposited Funds until a bank deposit groups it (books-api's `depositTo`),
 * and a check has a number. A Dutch business pays by transfer and direct debit.
 */

export type PaymentDirection = 'received' | 'sent';

export type DepositTarget = 'undeposited_funds' | 'bank';

/** The methods a US entity picks from, in display order (`PAYMENT_METHODS` on books-api). */
export const US_PAYMENT_METHODS = ['check', 'ach', 'wire', 'credit_card', 'debit_card', 'cash', 'other'] as const;

/** The methods every other jurisdiction picks from; `card` and `manual` are the values books-api maps. */
export const DEFAULT_PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'direct_debit', 'manual'] as const;

export type PaymentMethodValue =
  | (typeof US_PAYMENT_METHODS)[number]
  | (typeof DEFAULT_PAYMENT_METHODS)[number];

export function paymentMethodsFor(isUs: boolean): readonly PaymentMethodValue[] {
  return isUs ? US_PAYMENT_METHODS : DEFAULT_PAYMENT_METHODS;
}

export function defaultPaymentMethod(isUs: boolean): PaymentMethodValue {
  return isUs ? 'ach' : 'bank_transfer';
}

/** Checks and cash are the received payments that wait in Undeposited Funds by default. */
export function waitsInUndepositedFunds(method: string): boolean {
  return method === 'check' || method === 'cash';
}

/** Only a received check or cash has a choice to make: everything else is in the bank already. */
export function offersDepositChoice(isUs: boolean, direction: PaymentDirection, method: string): boolean {
  return isUs && direction === 'received' && waitsInUndepositedFunds(method);
}

export function takesCheckNumber(isUs: boolean, method: string): boolean {
  return isUs && method === 'check';
}

export interface PaymentExtras {
  checkNumber?: string;
  depositTo?: DepositTarget;
}

/**
 * The US-only fields of a payment request. Nothing is sent for other
 * jurisdictions, and `depositTo` only when the user had a choice to make, so
 * books-api's own default (Undeposited Funds for checks and cash) applies
 * whenever the entity has no such account.
 */
export function paymentExtras(args: {
  isUs: boolean;
  direction: PaymentDirection;
  method: string;
  checkNumber?: string;
  depositTo?: DepositTarget;
}): PaymentExtras {
  const extras: PaymentExtras = {};
  const checkNumber = args.checkNumber?.trim();
  if (takesCheckNumber(args.isUs, args.method) && checkNumber) extras.checkNumber = checkNumber;
  if (offersDepositChoice(args.isUs, args.direction, args.method)) {
    extras.depositTo = args.depositTo ?? 'undeposited_funds';
  }
  return extras;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

/** "••••1234" for the last four digits of an account number. */
export function maskedAccountNumber(last4: string | null | undefined): string | null {
  return last4 && /^\d{1,4}$/.test(last4) ? `••••${last4}` : null;
}

/** The account types of a US bank account (`BANK_ACCOUNT_TYPES` on books-api). */
export const BANK_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'money_market',
  'line_of_credit',
] as const;

export type BankAccountTypeValue = (typeof BANK_ACCOUNT_TYPES)[number];

export function isBankAccountType(value: string | null | undefined): value is BankAccountTypeValue {
  return !!value && (BANK_ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * The line under a bank account's name: a US account reads
 * "Chase · Checking ••••1234" (type and the last four digits, never IBAN-style
 * numbers), a European one its IBAN or bank name.
 */
export function bankAccountSubtitle(
  account: { iban?: string; bankName?: string; accountType?: string; accountNumberLast4?: string },
  typeLabels: Record<string, string>,
): string | undefined {
  const masked = maskedAccountNumber(account.accountNumberLast4);
  if (masked) {
    const type = isBankAccountType(account.accountType) ? typeLabels[account.accountType] : undefined;
    return [account.bankName, [type, masked].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  }
  return account.iban || account.bankName || undefined;
}
