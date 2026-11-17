import { z } from 'zod';

/** The subtypes a ledger account of each type can have, with their label keys. */
export const subtypesByType: Record<string, { value: string; labelKey: string }[]> = {
  asset: [
    { value: 'current_asset', labelKey: 'currentAsset' },
    { value: 'fixed_asset', labelKey: 'fixedAsset' },
    { value: 'bank', labelKey: 'bank' },
    { value: 'cash', labelKey: 'cash' },
    { value: 'accounts_receivable', labelKey: 'accountsReceivable' },
    { value: 'inventory', labelKey: 'inventory' },
    { value: 'prepaid_expense', labelKey: 'prepaidExpense' },
  ],
  liability: [
    { value: 'current_liability', labelKey: 'currentLiability' },
    { value: 'long_term_liability', labelKey: 'longTermLiability' },
    { value: 'accounts_payable', labelKey: 'accountsPayable' },
    { value: 'tax_payable', labelKey: 'taxPayable' },
    { value: 'credit_card', labelKey: 'creditCard' },
  ],
  equity: [
    { value: 'owners_equity', labelKey: 'ownersEquity' },
    { value: 'retained_earnings', labelKey: 'retainedEarnings' },
    { value: 'share_capital', labelKey: 'shareCapital' },
  ],
  revenue: [
    { value: 'sales', labelKey: 'sales' },
    { value: 'other_income', labelKey: 'otherIncome' },
    { value: 'interest_income', labelKey: 'interestIncome' },
    { value: 'service_revenue', labelKey: 'serviceRevenue' },
  ],
  expense: [
    { value: 'operating_expense', labelKey: 'operatingExpense' },
    { value: 'cost_of_goods_sold', labelKey: 'costOfGoodsSold' },
    { value: 'payroll', labelKey: 'payroll' },
    { value: 'depreciation', labelKey: 'depreciation' },
    { value: 'interest_expense', labelKey: 'interestExpense' },
    { value: 'tax_expense', labelKey: 'taxExpense' },
  ],
};

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type NormalSide = 'debit' | 'credit';

/** The side an account of this type normally carries its balance on. */
export function normalSideOf(type: string): NormalSide {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** The new account and edit account form. */
export function createAccountSchema(st: (key: string) => string) {
  return z.object({
    code: z.string().min(1, st('sweep.weldbooks.accountForm.codeRequired')),
    name: z.string().min(1, st('sweep.weldbooks.accountForm.nameRequired')),
    description: z.string().optional(),
    type: z.enum(ACCOUNT_TYPES, { errorMap: () => ({ message: st('sweep.weldbooks.accountForm.typeRequired') }) }),
    subtype: z.string().optional(),
    normalSide: z.enum(['debit', 'credit'], {
      errorMap: () => ({ message: st('sweep.weldbooks.accountForm.normalSideRequired') }),
    }),
    currency: z.string().optional(),
    openingBalance: z.coerce.number().optional(),
    isActive: z.boolean().optional(),
    taxLine: z.string().optional(),
    form1099Box: z.string().optional(),
  });
}

export type AccountFormValues = z.infer<ReturnType<typeof createAccountSchema>>;

/** The opening balance as the API takes it: a decimal string (`"0.00"`), not a number. */
export function openingBalancePayload(value: number | undefined): string | undefined {
  return value === undefined || Number.isNaN(value) ? undefined : value.toFixed(2);
}
