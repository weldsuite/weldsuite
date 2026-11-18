/**
 * A ledger account's balance as people read it. The ledger keeps every
 * account's balance as debit minus credit, so a credit-side account (revenue,
 * a liability, equity) with a normal balance comes back negative; on the
 * account's own side it is positive, as on the P&L and the balance sheet.
 */
export function balanceOnNormalSide(
  balance: number | string | null | undefined,
  normalSide: string | null | undefined,
): number | string | null | undefined {
  if (normalSide !== 'credit' || balance === null || balance === undefined || balance === '') return balance;
  const value = Number(balance);
  if (Number.isNaN(value)) return balance;
  // A zero balance stays 0, not -0 (which formats as "-€ 0,00").
  return value === 0 ? 0 : -value;
}
