import type { ChartOfAccountsTemplateRow } from '../types';

/**
 * Dutch RGS-aligned chart of accounts, seeded when an NL entity is created.
 * Includes realized FX gain/loss and rounding accounts so the FX-settlement
 * logic in accounting-payments.ts has stable targets.
 */
export const nlChartOfAccounts: ChartOfAccountsTemplateRow[] = [
  // Assets
  { code: '0100', name: 'Immateriële vaste activa', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  { code: '0200', name: 'Materiële vaste activa', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  { code: '0300', name: 'Financiële vaste activa', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  { code: '1000', name: 'Liquide middelen', type: 'asset', subtype: 'bank', normalSide: 'debit' },
  { code: '1001', name: 'Kas', type: 'asset', subtype: 'cash', normalSide: 'debit' },
  { code: '1100', name: 'Bank', type: 'asset', subtype: 'bank', normalSide: 'debit' },
  { code: '1200', name: 'Spaarrekening', type: 'asset', subtype: 'bank', normalSide: 'debit' },
  { code: '1300', name: 'Debiteuren', type: 'asset', subtype: 'accounts_receivable', normalSide: 'debit', isSystemAccount: true, systemRole: 'accounts_receivable' },
  { code: '1350', name: 'Nog te ontvangen bedragen', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1400', name: 'Vooruitbetaalde bedragen', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1500', name: 'Voorraad', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1510', name: 'Onderhanden werk', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1520', name: 'BTW te vorderen', type: 'asset', subtype: 'tax', normalSide: 'debit', isSystemAccount: true },

  // Liabilities
  { code: '1600', name: 'Crediteuren', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit', isSystemAccount: true, systemRole: 'accounts_payable' },
  { code: '1700', name: 'BTW te betalen', type: 'liability', subtype: 'tax', normalSide: 'credit', isSystemAccount: true, systemRole: 'tax_payable' },
  { code: '1710', name: 'BTW hoog tarief', type: 'liability', subtype: 'tax', normalSide: 'credit', isSystemAccount: true, systemRole: 'tax_output_standard' },
  { code: '1720', name: 'BTW laag tarief', type: 'liability', subtype: 'tax', normalSide: 'credit', isSystemAccount: true, systemRole: 'tax_output_reduced' },
  { code: '1730', name: 'BTW voorbelasting', type: 'liability', subtype: 'tax', normalSide: 'debit', isSystemAccount: true, systemRole: 'tax_input' },
  { code: '1740', name: 'BTW afdracht', type: 'liability', subtype: 'tax', normalSide: 'credit', isSystemAccount: true },
  { code: '1800', name: 'Loonheffing te betalen', type: 'liability', subtype: 'tax', normalSide: 'credit' },
  { code: '1900', name: 'Nog te betalen bedragen', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },
  { code: '1950', name: 'Vooruit ontvangen bedragen', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },
  { code: '2000', name: 'Langlopende leningen', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },

  // Equity
  { code: '0500', name: 'Eigen vermogen', type: 'equity', subtype: 'capital', normalSide: 'credit' },
  { code: '0510', name: 'Aandelenkapitaal', type: 'equity', subtype: 'capital', normalSide: 'credit' },
  { code: '0520', name: 'Reserves', type: 'equity', subtype: 'retained_earnings', normalSide: 'credit' },
  { code: '0530', name: 'Onverdeelde winst', type: 'equity', subtype: 'retained_earnings', normalSide: 'credit', isSystemAccount: true, systemRole: 'retained_earnings' },
  { code: '0540', name: 'Privé', type: 'equity', subtype: 'capital', normalSide: 'debit' },

  // Revenue
  { code: '8000', name: 'Omzet', type: 'revenue', subtype: 'other_income', normalSide: 'credit', isSystemAccount: true, systemRole: 'sales_revenue' },
  { code: '8010', name: 'Omzet producten', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8020', name: 'Omzet diensten', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8030', name: 'Omzet abonnementen', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8100', name: 'Overige opbrengsten', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8200', name: 'Financiële baten', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8300', name: 'Buitengewone baten', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  { code: '8400', name: 'Koerswinst', type: 'revenue', subtype: 'other_income', normalSide: 'credit', isSystemAccount: true, systemRole: 'realized_fx_gain' },
  { code: '8500', name: 'Korting gegeven', type: 'revenue', subtype: 'other_income', normalSide: 'debit' },

  // Expenses
  { code: '4000', name: 'Inkoopkosten', type: 'expense', subtype: 'cost_of_goods', normalSide: 'debit' },
  { code: '4010', name: 'Inkoop producten', type: 'expense', subtype: 'cost_of_goods', normalSide: 'debit' },
  { code: '4100', name: 'Personeelskosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4110', name: 'Lonen en salarissen', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4120', name: 'Sociale lasten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4130', name: 'Pensioenlasten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4200', name: 'Huisvestingskosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4210', name: 'Huur', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4220', name: 'Gas, water, elektra', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4300', name: 'Kantoorkosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4310', name: 'Kantoorbenodigdheden', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4320', name: 'Telefoon en internet', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4330', name: 'Porto en verzendkosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4340', name: 'Software en licenties', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4400', name: 'Vervoerskosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4410', name: 'Autokosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4420', name: 'Reiskosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4500', name: 'Verkoopkosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4510', name: 'Reclame en marketing', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4520', name: 'Representatiekosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4600', name: 'Algemene kosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4610', name: 'Verzekeringen', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4620', name: 'Accountantskosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4630', name: 'Juridische kosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4640', name: 'Contributies en abonnementen', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4650', name: 'Bankkosten', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4700', name: 'Afschrijvingen', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4800', name: 'Financiële lasten', type: 'expense', subtype: 'other_expense', normalSide: 'debit' },
  { code: '4810', name: 'Rentelasten', type: 'expense', subtype: 'other_expense', normalSide: 'debit' },
  { code: '4900', name: 'Buitengewone lasten', type: 'expense', subtype: 'other_expense', normalSide: 'debit' },
  { code: '4950', name: 'Koersverschillen', type: 'expense', subtype: 'other_expense', normalSide: 'debit', isSystemAccount: true, systemRole: 'realized_fx_loss' },
];
