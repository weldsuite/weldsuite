/**
 * Client-side checks of a US bank account's routing and account numbers. The
 * server checks them again (`services/accounting-bank-accounts.ts`).
 */

/** ABA routing number check: nine digits, weights 3-7-1, sum divisible by 10. */
export function isValidAbaRouting(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...value].reduce((total, digit, i) => total + Number(digit) * weights[i], 0);
  return sum % 10 === 0;
}

export type RoutingNumberProblem = 'format' | 'checksum';

/** `null` when the routing number is acceptable (or empty). */
export function routingNumberProblem(value: string): RoutingNumberProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{9}$/.test(trimmed)) return 'format';
  return isValidAbaRouting(trimmed) ? null : 'checksum';
}

/** Account numbers as people type them: spaces and dashes dropped, 4 to 34 letters or digits. */
export function normalizeAccountNumber(value: string): string | null {
  const cleaned = value.replaceAll(/[\s-]/g, '');
  return /^[0-9A-Za-z*]{4,34}$/.test(cleaned) ? cleaned : null;
}

/** `•••• 1234` for an account number of which only the last four characters are known. */
export function maskedAccountNumber(last4: string | null | undefined): string {
  return `•••• ${last4 || '••••'}`;
}
