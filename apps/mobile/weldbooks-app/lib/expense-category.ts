/**
 * Which expense account a quick-expense category books to.
 *
 * The categories are a fixed set of tiles, but the accounts are the company's
 * own chart, seeded per jurisdiction (NL `4300 Kantoorkosten`, US `6110 Office
 * expenses`, IN `Office expenses`, BR `Material de escritório e consumo`) and
 * editable afterwards. So the account is found by name, the first match per
 * category winning, and the form shows it so a wrong guess can be corrected.
 * No match books to the server's default expense account, as before.
 */

import type { ExpenseCategory, GlAccount } from '@/types/accounting';

/** Name patterns per category, most specific first. Dutch, English and Portuguese charts. */
const CATEGORY_PATTERNS: Record<ExpenseCategory, RegExp[]> = {
  food: [/\bmeals?\b/i, /representatie/i, /refei[çc]/i, /aliment/i, /kantine/i, /entertainment/i],
  transport: [/autokosten/i, /car and truck/i, /vervoer/i, /conveyance/i, /ve[íi]cul/i, /combust/i],
  office: [/kantoorkosten/i, /office expense/i, /escrit[óo]rio/i, /kantoorbenodigd/i],
  travel: [/reiskosten/i, /\btravel/i, /viage/i],
  supplies: [/kantoorbenodigd/i, /\bsupplies\b/i, /material de/i, /consumo/i],
  utilities: [/gas, water/i, /\butilities\b/i, /energia/i, /energie/i, /elektra/i, /telefoon/i],
  insurance: [/verzekering/i, /\binsurance\b/i, /seguro/i],
  other: [/algemene kosten/i, /general expense/i, /other expense/i, /despesas gerais/i],
};

/** The active expense accounts, by code. */
export function expenseAccounts(accounts: readonly GlAccount[]): GlAccount[] {
  return accounts
    .filter((account) => account.type === 'expense' && account.isActive !== false)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/** The account a category books to, or null for the server's default. */
export function accountForCategory(category: ExpenseCategory, accounts: readonly GlAccount[]): GlAccount | null {
  const candidates = expenseAccounts(accounts);
  for (const pattern of CATEGORY_PATTERNS[category]) {
    const match = candidates.find((account) => pattern.test(account.name));
    if (match) return match;
  }
  return null;
}
