import { createCrudRoute } from '../../../lib/crud-route';
import { schema } from '../../../db';
import {
  createAccountingEntitySchema,
  updateAccountingEntitySchema,
} from '@weldsuite/core-api-client/schemas/accounting-entities';
import {
  createGlAccountSchema,
  updateGlAccountSchema,
} from '@weldsuite/core-api-client/schemas/gl-accounts';
import {
  createInvoiceSchema,
  updateInvoiceSchema,
} from '@weldsuite/core-api-client/schemas/invoices';
import {
  createBillSchema,
  updateBillSchema,
} from '@weldsuite/core-api-client/schemas/bills';
import {
  createJournalEntrySchema,
  updateJournalEntrySchema,
} from '@weldsuite/core-api-client/schemas/journal-entries';
import {
  createPaymentSchema,
  updatePaymentSchema,
} from '@weldsuite/core-api-client/schemas/payments';
import {
  createBankAccountSchema,
  updateBankAccountSchema,
} from '@weldsuite/core-api-client/schemas/bank-accounts';
import {
  createBankTransactionSchema,
  updateBankTransactionSchema,
} from '@weldsuite/core-api-client/schemas/bank-transactions';
import {
  createTaxRateSchema,
  updateTaxRateSchema,
} from '@weldsuite/core-api-client/schemas/tax-rates';
import {
  createRecurringInvoiceSchema,
  updateRecurringInvoiceSchema,
} from '@weldsuite/core-api-client/schemas/recurring-invoices';
import {
  createReconciliationRuleSchema,
  updateReconciliationRuleSchema,
} from '@weldsuite/core-api-client/schemas/reconciliation-rules';
import {
  createFiscalPeriodSchema,
  updateFiscalPeriodSchema,
} from '@weldsuite/core-api-client/schemas/fiscal-periods';
import {
  createFxRateSchema,
  updateFxRateSchema,
} from '@weldsuite/core-api-client/schemas/fx-rates';
import {
  createVatReturnSchema,
  updateVatReturnSchema,
} from '@weldsuite/core-api-client/schemas/vat-returns';
import {
  createAccountingDocumentSchema,
  updateAccountingDocumentSchema,
} from '@weldsuite/core-api-client/schemas/accounting-documents';

function mapAccountingEntity(body: Record<string, unknown>): Record<string, unknown> {
  const jurisdictionCode = String(body.jurisdictionCode ?? body.jurisdiction ?? 'NL').toUpperCase();
  const { jurisdiction, vatNumber, registrationNumber, fiscalYearStartMonth, ...rest } = body;
  const taxIdentifiers =
    vatNumber !== undefined || registrationNumber !== undefined
      ? {
          ...(typeof rest.taxIdentifiers === 'object' && rest.taxIdentifiers ? rest.taxIdentifiers : {}),
          ...(vatNumber !== undefined ? { vatNumber } : {}),
          ...(registrationNumber !== undefined ? { registrationNumber } : {}),
        }
      : rest.taxIdentifiers;
  return {
    ...rest,
    jurisdictionCode,
    baseCurrency: rest.baseCurrency ?? 'EUR',
    locale: rest.locale ?? 'nl-NL',
    fiscalYearStart: fiscalYearStartMonth ?? rest.fiscalYearStart ?? 1,
    isActive: rest.isActive ?? true,
    ...(taxIdentifiers !== undefined ? { taxIdentifiers } : {}),
  };
}

function mapGlAccount(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    type: body.type ?? 'asset',
    normalSide: body.normalSide ?? 'debit',
    openingBalance: body.openingBalance ?? '0',
    currentBalance: body.currentBalance ?? '0',
    currency: body.currency ?? 'EUR',
  };
}

function mapTaxRate(body: Record<string, unknown>): Record<string, unknown> {
  const jurisdictionCode = body.jurisdictionCode ?? body.jurisdiction;
  const { jurisdiction, ...rest } = body;
  return {
    ...rest,
    ...(jurisdictionCode !== undefined
      ? { jurisdictionCode: String(jurisdictionCode).toUpperCase() }
      : {}),
    rate: body.rate !== undefined ? String(body.rate) : body.rate,
    isActive: body.isActive ?? true,
  };
}

export const accountingEntities = createCrudRoute({
  table: schema.entities,
  scope: 'accounting_entities',
  label: 'Accounting entity',
  idPrefix: 'ent',
  entityType: 'accounting_entity',
  createSchema: createAccountingEntitySchema,
  updateSchema: updateAccountingEntitySchema,
  prepareCreate: mapAccountingEntity,
  prepareUpdate: (body, existing) => mapAccountingEntity({ ...existing, ...body }),
  eventData: (row) => ({ id: row.id, name: row.name, jurisdictionCode: row.jurisdictionCode }),
});

export const glAccounts = createCrudRoute({
  table: schema.accounts,
  scope: 'gl_accounts',
  label: 'GL account',
  idPrefix: 'acc',
  entityType: 'account',
  createSchema: createGlAccountSchema,
  updateSchema: updateGlAccountSchema,
  prepareCreate: mapGlAccount,
  prepareUpdate: (body) => mapGlAccount(body),
  eventData: (row) => ({ id: row.id, code: row.code, name: row.name }),
});

export const invoices = createCrudRoute({
  table: schema.invoices,
  scope: 'invoices',
  label: 'Invoice',
  idPrefix: 'inv',
  entityType: 'invoice',
  createSchema: createInvoiceSchema,
  updateSchema: updateInvoiceSchema,
  eventData: (row) => ({ id: row.id, status: row.status, total: row.total }),
});

export const bills = createCrudRoute({
  table: schema.bills,
  scope: 'bills',
  label: 'Bill',
  idPrefix: 'bil',
  entityType: 'bill',
  createSchema: createBillSchema,
  updateSchema: updateBillSchema,
  eventData: (row) => ({ id: row.id, status: row.status, total: row.total }),
});

export const journalEntries = createCrudRoute({
  table: schema.journalEntries,
  scope: 'journal_entries',
  label: 'Journal entry',
  idPrefix: 'je',
  entityType: 'journal_entry',
  createSchema: createJournalEntrySchema,
  updateSchema: updateJournalEntrySchema,
  eventData: (row) => ({ id: row.id, status: row.status }),
});

export const payments = createCrudRoute({
  table: schema.payments,
  scope: 'payments',
  label: 'Payment',
  idPrefix: 'pay',
  entityType: 'payment',
  createSchema: createPaymentSchema,
  updateSchema: updatePaymentSchema,
  eventData: (row) => ({ id: row.id, amount: row.amount, status: row.status }),
});

export const bankAccounts = createCrudRoute({
  table: schema.bankAccounts,
  scope: 'bank_accounts',
  label: 'Bank account',
  idPrefix: 'ba',
  entityType: 'bank_account',
  createSchema: createBankAccountSchema,
  updateSchema: updateBankAccountSchema,
  eventData: (row) => ({ id: row.id, name: row.name }),
});

export const bankTransactions = createCrudRoute({
  table: schema.bankTransactions,
  scope: 'bank_transactions',
  label: 'Bank transaction',
  idPrefix: 'bt',
  entityType: 'bank_transaction',
  createSchema: createBankTransactionSchema,
  updateSchema: updateBankTransactionSchema,
  eventData: (row) => ({ id: row.id, amount: row.amount, status: row.status }),
});

export const taxRates = createCrudRoute({
  table: schema.taxRates,
  scope: 'tax_rates',
  label: 'Tax rate',
  idPrefix: 'txr',
  entityType: 'tax_rate',
  createSchema: createTaxRateSchema,
  updateSchema: updateTaxRateSchema,
  prepareCreate: mapTaxRate,
  prepareUpdate: (body) => mapTaxRate(body),
  eventData: (row) => ({ id: row.id, name: row.name, rate: row.rate }),
});

export const recurringInvoices = createCrudRoute({
  table: schema.recurringInvoices,
  scope: 'recurring_invoices',
  label: 'Recurring invoice',
  idPrefix: 'ri',
  entityType: 'recurring_invoice',
  createSchema: createRecurringInvoiceSchema,
  updateSchema: updateRecurringInvoiceSchema,
  eventData: (row) => ({ id: row.id, status: row.status }),
});

export const reconciliationRules = createCrudRoute({
  table: schema.reconciliationRules,
  scope: 'reconciliation_rules',
  label: 'Reconciliation rule',
  idPrefix: 'rr',
  entityType: 'reconciliation_rule',
  createSchema: createReconciliationRuleSchema,
  updateSchema: updateReconciliationRuleSchema,
  eventData: (row) => ({ id: row.id, name: row.name }),
});

export const fiscalPeriods = createCrudRoute({
  table: schema.fiscalPeriods,
  scope: 'fiscal_periods',
  label: 'Fiscal period',
  idPrefix: 'fp',
  entityType: 'fiscal_period',
  createSchema: createFiscalPeriodSchema,
  updateSchema: updateFiscalPeriodSchema,
  eventData: (row) => ({ id: row.id, status: row.status }),
});

export const fxRates = createCrudRoute({
  table: schema.fxRates,
  scope: 'fx_rates',
  label: 'FX rate',
  idPrefix: 'fx',
  entityType: 'fx_rate',
  createSchema: createFxRateSchema,
  updateSchema: updateFxRateSchema,
  eventData: (row) => ({ id: row.id, fromCurrency: row.fromCurrency, toCurrency: row.toCurrency }),
});

export const vatReturns = createCrudRoute({
  table: schema.vatReturns,
  scope: 'vat_returns',
  label: 'VAT return',
  idPrefix: 'vat',
  entityType: 'vat_return',
  createSchema: createVatReturnSchema,
  updateSchema: updateVatReturnSchema,
  eventData: (row) => ({ id: row.id, status: row.status }),
});

export const accountingDocuments = createCrudRoute({
  table: schema.documents,
  scope: 'accounting_documents',
  label: 'Accounting document',
  idPrefix: 'doc',
  entityType: 'accounting_document',
  createSchema: createAccountingDocumentSchema,
  updateSchema: updateAccountingDocumentSchema,
  eventData: (row) => ({ id: row.id, status: row.status, type: row.type }),
});
