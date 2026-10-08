/**
 * WeldBooks resources the public API serves for reading only.
 *
 * Every one of these changes the books, or feeds a posting, so writes belong in
 * books-api, which calculates tax, numbers and posts documents to the ledger,
 * enforces periods and lock dates, seeds new entities and writes the audit log.
 * See `read-only-route.ts` for the shared behaviour (list + get, 405 on writes).
 *
 * - invoices (credit notes included), bills, payments, journal entries,
 *   bank transactions, VAT returns, ICP declarations, recurring invoices:
 *   documents and returns that post to the ledger or the tax ledger.
 * - accounting entities, GL accounts, tax rates, fiscal periods, FX rates:
 *   the setup the ledger is built on. A generic insert skipped entity seeding
 *   (no chart of accounts) and defaulted every entity to NL / EUR.
 * - bank accounts: carry the ledger account payments post against.
 * - reconciliation rules: free-form conditions and actions that decide which
 *   ledger and tax accounts bank lines are categorised to.
 * - accounting documents: the document inbox is a state machine owned by
 *   books-api (OCR, vendor match, link, reject) and the public API has no
 *   upload path for the file a row points at.
 *
 * Accounting settings are read-only too (`../accounting-settings`). Accounting
 * contacts are the only WeldBooks resource that stays writable
 * (`../accounting-contacts`): they live on `parties`, the counterparty table
 * shared with the CRM, and the public API only writes their name and role.
 */

import { createReadOnlyRoute } from './read-only-route';
import { schema } from '../../../db';

export const accountingEntities = createReadOnlyRoute({
  table: schema.entities,
  scope: 'accounting_entities',
  label: 'Accounting entity',
  noun: 'accounting entities',
});

export const glAccounts = createReadOnlyRoute({
  table: schema.accounts,
  scope: 'gl_accounts',
  label: 'GL account',
  noun: 'GL accounts',
});

export const invoices = createReadOnlyRoute({
  table: schema.invoices,
  scope: 'invoices',
  label: 'Invoice',
  noun: 'invoices',
});

export const bills = createReadOnlyRoute({
  table: schema.bills,
  scope: 'bills',
  label: 'Bill',
  noun: 'bills',
});

export const journalEntries = createReadOnlyRoute({
  table: schema.journalEntries,
  scope: 'journal_entries',
  label: 'Journal entry',
  noun: 'journal entries',
});

export const payments = createReadOnlyRoute({
  table: schema.payments,
  scope: 'payments',
  label: 'Payment',
  noun: 'payments',
});

export const bankAccounts = createReadOnlyRoute({
  table: schema.bankAccounts,
  scope: 'bank_accounts',
  label: 'Bank account',
  noun: 'bank accounts',
});

export const bankTransactions = createReadOnlyRoute({
  table: schema.bankTransactions,
  scope: 'bank_transactions',
  label: 'Bank transaction',
  noun: 'bank transactions',
});

export const taxRates = createReadOnlyRoute({
  table: schema.taxRates,
  scope: 'tax_rates',
  label: 'Tax rate',
  noun: 'tax rates',
});

export const recurringInvoices = createReadOnlyRoute({
  table: schema.recurringInvoices,
  scope: 'recurring_invoices',
  label: 'Recurring invoice',
  noun: 'recurring invoices',
});

export const reconciliationRules = createReadOnlyRoute({
  table: schema.reconciliationRules,
  scope: 'reconciliation_rules',
  label: 'Reconciliation rule',
  noun: 'reconciliation rules',
});

export const fiscalPeriods = createReadOnlyRoute({
  table: schema.fiscalPeriods,
  scope: 'fiscal_periods',
  label: 'Fiscal period',
  noun: 'fiscal periods',
});

export const fxRates = createReadOnlyRoute({
  table: schema.fxRates,
  scope: 'fx_rates',
  label: 'FX rate',
  noun: 'FX rates',
});

export const vatReturns = createReadOnlyRoute({
  table: schema.vatReturns,
  scope: 'vat_returns',
  label: 'VAT return',
  noun: 'VAT returns',
});

export const icpDeclarations = createReadOnlyRoute({
  table: schema.icpDeclarations,
  scope: 'icp_declarations',
  label: 'ICP declaration',
  noun: 'ICP declarations',
});

export const accountingDocuments = createReadOnlyRoute({
  table: schema.documents,
  scope: 'accounting_documents',
  label: 'Accounting document',
  noun: 'accounting documents',
});
