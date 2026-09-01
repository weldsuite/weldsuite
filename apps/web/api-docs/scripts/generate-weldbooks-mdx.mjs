/**
 * Generates WeldBooks api-docs pages as page.mdx (matching the CRM/Flow doc style).
 * Run: node scripts/generate-weldbooks-mdx.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '../src/app')

const API = 'https://api.weldsuite.org/v1'

const configs = [
  {
    slug: 'accounting-entities',
    title: 'Accounting entities',
    lead:
      'Legal entities in WeldBooks — each has its own chart of accounts, tax rates, and books. Mutations require the `accounting_entities:write` scope; reads require `accounting_entities:read`.',
    endpoint: 'accounting-entities',
    scope: 'accounting_entities',
    idPrefix: 'ent',
    resourceSingular: 'accounting entity',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `ent_abc123`).' },
      { name: 'name', type: 'string', description: 'Display name of the entity.' },
      { name: 'legalName', type: 'string', description: 'Registered legal name.' },
      { name: 'jurisdictionCode', type: 'string', description: 'ISO jurisdiction code (e.g. `NL`, `BE`).' },
      { name: 'baseCurrency', type: 'string', description: 'Functional currency (e.g. `EUR`).' },
      { name: 'locale', type: 'string', description: 'Locale for formatting (e.g. `nl-NL`).' },
      { name: 'isDefault', type: 'boolean', description: 'Whether this is the workspace default entity.' },
      { name: 'isActive', type: 'boolean', description: 'Whether the entity is active.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'name', type: 'string', description: 'Entity name.' }],
    createOptionalNote:
      'Optional: `legalName`, `jurisdiction` / `jurisdictionCode`, `baseCurrency`, `vatNumber`, `registrationNumber`, `fiscalYearStartMonth`, `isDefault`. The API accepts `jurisdiction` as an alias for `jurisdictionCode`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`.',
    createExample: { name: 'Acme Books BV', jurisdiction: 'NL', baseCurrency: 'EUR' },
  },
  {
    slug: 'gl-accounts',
    title: 'GL accounts',
    lead:
      'Chart-of-accounts lines (general ledger). Mutations require the `gl_accounts:write` scope; reads require `gl_accounts:read`.',
    endpoint: 'gl-accounts',
    scope: 'gl_accounts',
    idPrefix: 'acc',
    resourceSingular: 'GL account',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `acc_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'code', type: 'string', description: 'Account code.' },
      { name: 'name', type: 'string', description: 'Account name.' },
      { name: 'type', type: 'string', description: 'Account type (`asset`, `liability`, `equity`, `revenue`, `expense`).' },
      { name: 'normalSide', type: 'string', description: 'Normal balance side (`debit` or `credit`).' },
      { name: 'isActive', type: 'boolean', description: 'Whether the account is active.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [
      { name: 'code', type: 'string', description: 'Account code.' },
      { name: 'name', type: 'string', description: 'Account name.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `type`, `parentId`, `description`, `isActive`. Defaults: `type=asset`, `normalSide=debit`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', code: '1000', name: 'Cash', type: 'asset' },
  },
  {
    slug: 'invoices',
    title: 'Invoices',
    lead:
      'Customer invoices (accounts receivable). Mutations require the `invoices:write` scope; reads require `invoices:read`.',
    endpoint: 'invoices',
    scope: 'invoices',
    idPrefix: 'inv',
    resourceSingular: 'invoice',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `inv_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'invoiceNumber', type: 'string', description: 'Human-readable invoice number.' },
      { name: 'status', type: 'string', description: 'Lifecycle status (`draft`, `sent`, `paid`, …).' },
      { name: 'contactId', type: 'string', description: 'Customer / accounting contact.' },
      { name: 'issueDate', type: 'string', description: 'Issue date.' },
      { name: 'dueDate', type: 'string', description: 'Due date.' },
      { name: 'currency', type: 'string', description: 'Invoice currency.' },
      { name: 'total', type: 'string', description: 'Grand total (decimal string).' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Common fields: `entityId`, `customerId`, `customerName`, `reference`, `issueDate`, `dueDate`, `currency`, line items via `items`. Workflow actions (finalize, send, PDF) are available on the first-party app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', customerName: 'Smith Industries', currency: 'EUR' },
  },
  {
    slug: 'bills',
    title: 'Bills',
    lead:
      'Supplier bills (accounts payable). Mutations require the `bills:write` scope; reads require `bills:read`.',
    endpoint: 'bills',
    scope: 'bills',
    idPrefix: 'bil',
    resourceSingular: 'bill',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `bil_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'billNumber', type: 'string', description: 'Bill reference number.' },
      { name: 'status', type: 'string', description: 'Approval / payment status.' },
      { name: 'supplierId', type: 'string', description: 'Supplier contact.' },
      { name: 'issueDate', type: 'string', description: 'Bill date.' },
      { name: 'dueDate', type: 'string', description: 'Due date.' },
      { name: 'total', type: 'string', description: 'Grand total (decimal string).' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Common fields: `entityId`, `supplierId`, `supplierName`, `reference`, `issueDate`, `dueDate`, `currency`, `items`. Approval workflows remain on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', supplierName: 'Office Supplies Co', currency: 'EUR' },
  },
  {
    slug: 'journal-entries',
    title: 'Journal entries',
    lead:
      'Manual double-entry journal entries. Mutations require the `journal_entries:write` scope; reads require `journal_entries:read`.',
    endpoint: 'journal-entries',
    scope: 'journal_entries',
    idPrefix: 'je',
    resourceSingular: 'journal entry',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `je_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'entryNumber', type: 'string', description: 'Journal entry number.' },
      { name: 'description', type: 'string', description: 'Entry description.' },
      { name: 'date', type: 'string', description: 'Posting date.' },
      { name: 'status', type: 'string', description: 'Draft or posted.' },
      { name: 'totalDebit', type: 'string', description: 'Total debits.' },
      { name: 'totalCredit', type: 'string', description: 'Total credits.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Optional: `entityId`, `reference`, `description`, `date`, `lines` (debit/credit lines). Post and reverse actions are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', description: 'Month-end accrual' },
  },
  {
    slug: 'payments',
    title: 'Payments',
    lead:
      'Payments applied to invoices or bills. Mutations require the `payments:write` scope; reads require `payments:read`.',
    endpoint: 'payments',
    scope: 'payments',
    idPrefix: 'pay',
    resourceSingular: 'payment',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `pay_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'amount', type: 'string', description: 'Payment amount (decimal string).' },
      { name: 'currency', type: 'string', description: 'Payment currency.' },
      { name: 'direction', type: 'string', description: '`inbound` or `outbound`.' },
      { name: 'invoiceId', type: 'string', description: 'Linked invoice (if any).' },
      { name: 'billId', type: 'string', description: 'Linked bill (if any).' },
      { name: 'paymentDate', type: 'string', description: 'Date of payment.' },
      { name: 'status', type: 'string', description: 'Payment status.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'amount', type: 'string | number', description: 'Payment amount.' }],
    createOptionalNote:
      'Optional: `entityId`, `direction`, `invoiceId`, `billId`, `bankAccountId`, `currency`, `paymentDate`, `method`, `reference`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', amount: '1250.00', currency: 'EUR', direction: 'inbound' },
  },
  {
    slug: 'bank-accounts',
    title: 'Bank accounts',
    lead:
      'Bank accounts linked to the general ledger. Mutations require the `bank_accounts:write` scope; reads require `bank_accounts:read`.',
    endpoint: 'bank-accounts',
    scope: 'bank_accounts',
    idPrefix: 'ba',
    resourceSingular: 'bank account',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `ba_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'name', type: 'string', description: 'Account label.' },
      { name: 'iban', type: 'string', description: 'IBAN.' },
      { name: 'currency', type: 'string', description: 'Account currency.' },
      { name: 'glAccountId', type: 'string', description: 'Linked GL cash account.' },
      { name: 'isActive', type: 'boolean', description: 'Whether the account is active.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'name', type: 'string', description: 'Account name.' }],
    createOptionalNote: 'Optional: `entityId`, `bankName`, `iban`, `accountNumber`, `currency`, `glAccountId`, `isActive`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', name: 'Operating account', currency: 'EUR' },
  },
  {
    slug: 'bank-transactions',
    title: 'Bank transactions',
    lead:
      'Imported or manual bank statement lines. Mutations require the `bank_transactions:write` scope; reads require `bank_transactions:read`.',
    endpoint: 'bank-transactions',
    scope: 'bank_transactions',
    idPrefix: 'bt',
    resourceSingular: 'bank transaction',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `bt_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'bankAccountId', type: 'string', description: 'Parent bank account.' },
      { name: 'amount', type: 'string', description: 'Signed amount (decimal string).' },
      { name: 'currency', type: 'string', description: 'Transaction currency.' },
      { name: 'transactionDate', type: 'string', description: 'Value date.' },
      { name: 'description', type: 'string', description: 'Bank description / memo.' },
      { name: 'status', type: 'string', description: 'Reconciliation status.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Optional: `entityId`, `bankAccountId`, `amount`, `currency`, `transactionDate`, `reference`, `counterpartyName`. Import and reconcile flows are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', bankAccountId: 'ba_abc123', amount: '-45.00', currency: 'EUR' },
  },
  {
    slug: 'accounting-contacts',
    title: 'Accounting contacts',
    lead:
      'Customers and suppliers on invoices and bills (backed by the unified `parties` layer). Mutations require the `accounting_contacts:write` scope; reads require `accounting_contacts:read`.',
    endpoint: 'accounting-contacts',
    scope: 'accounting_contacts',
    idPrefix: 'acn',
    resourceSingular: 'accounting contact',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `acn_abc123`).' },
      { name: 'name', type: 'string', description: 'Contact display name.' },
      { name: 'type', type: 'string', description: 'Role: `customer`, `supplier`, or `both`.' },
      { name: 'email', type: 'string', description: 'Email address.' },
      { name: 'phone', type: 'string', description: 'Phone number.' },
      { name: 'taxNumber', type: 'string', description: 'VAT / tax number.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'name', type: 'string', description: 'Contact name.' }],
    createOptionalNote: 'Optional: `type`, `email`, `phone`, `taxNumber`, `isActive`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `search`, `role`.',
    createExample: { name: 'Smith Industries', type: 'customer', email: 'ap@smith.example' },
  },
  {
    slug: 'tax-rates',
    title: 'Tax rates',
    lead:
      'VAT / GST rate definitions per entity. Mutations require the `tax_rates:write` scope; reads require `tax_rates:read`.',
    endpoint: 'tax-rates',
    scope: 'tax_rates',
    idPrefix: 'txr',
    resourceSingular: 'tax rate',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `txr_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'name', type: 'string', description: 'Rate label (e.g. "21% BTW").' },
      { name: 'rate', type: 'string', description: 'Percentage as decimal string.' },
      { name: 'jurisdictionCode', type: 'string', description: 'Jurisdiction code.' },
      { name: 'isActive', type: 'boolean', description: 'Whether the rate is active.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [
      { name: 'name', type: 'string', description: 'Rate name.' },
      { name: 'rate', type: 'string | number', description: 'Rate percentage.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `jurisdiction` / `jurisdictionCode`, `isActive`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', name: '21% BTW', rate: 21, jurisdiction: 'NL' },
  },
  {
    slug: 'recurring-invoices',
    title: 'Recurring invoices',
    lead:
      'Scheduled invoice templates. Mutations require the `recurring_invoices:write` scope; reads require `recurring_invoices:read`.',
    endpoint: 'recurring-invoices',
    scope: 'recurring_invoices',
    idPrefix: 'ri',
    resourceSingular: 'recurring invoice',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `ri_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'contactId', type: 'string', description: 'Customer contact.' },
      { name: 'frequency', type: 'string', description: 'Billing frequency.' },
      { name: 'status', type: 'string', description: 'Active or paused.' },
      { name: 'nextRunDate', type: 'string', description: 'Next generation date.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Optional: `entityId`, `contactId`, `frequency`, `currency`, template line items. Generate and pause actions are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', contactId: 'acn_abc123', frequency: 'monthly' },
  },
  {
    slug: 'reconciliation-rules',
    title: 'Reconciliation rules',
    lead:
      'Rules that auto-match bank transactions to ledger entries. Mutations require the `reconciliation_rules:write` scope; reads require `reconciliation_rules:read`.',
    endpoint: 'reconciliation-rules',
    scope: 'reconciliation_rules',
    idPrefix: 'rr',
    resourceSingular: 'reconciliation rule',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `rr_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'name', type: 'string', description: 'Rule name.' },
      { name: 'priority', type: 'number', description: 'Evaluation order.' },
      { name: 'isActive', type: 'boolean', description: 'Whether the rule is active.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `name`, `matchCriteria`, `actions` (passthrough JSON).',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', name: 'Match supplier payments' },
  },
  {
    slug: 'fiscal-periods',
    title: 'Fiscal periods',
    lead:
      'Open / closed accounting periods. Mutations require the `fiscal_periods:write` scope; reads require `fiscal_periods:read`.',
    endpoint: 'fiscal-periods',
    scope: 'fiscal_periods',
    idPrefix: 'fp',
    resourceSingular: 'fiscal period',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `fp_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'name', type: 'string', description: 'Period label.' },
      { name: 'startDate', type: 'string', description: 'Period start.' },
      { name: 'endDate', type: 'string', description: 'Period end.' },
      { name: 'status', type: 'string', description: 'Open or closed.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [
      { name: 'name', type: 'string', description: 'Period name.' },
      { name: 'startDate', type: 'string', description: 'Start date.' },
      { name: 'endDate', type: 'string', description: 'End date.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `status`, `type`. Close and reopen actions are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', name: '2024-Q4', startDate: '2024-10-01', endDate: '2024-12-31' },
  },
  {
    slug: 'fx-rates',
    title: 'FX rates',
    lead:
      'Exchange rates for multi-currency bookkeeping. Mutations require the `fx_rates:write` scope; reads require `fx_rates:read`.',
    endpoint: 'fx-rates',
    scope: 'fx_rates',
    idPrefix: 'fx',
    resourceSingular: 'FX rate',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `fx_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'fromCurrency', type: 'string', description: 'Source currency.' },
      { name: 'toCurrency', type: 'string', description: 'Target currency.' },
      { name: 'rate', type: 'string', description: 'Exchange rate (decimal string).' },
      { name: 'effectiveDate', type: 'string', description: 'Date the rate applies.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `fromCurrency`, `toCurrency`, `rate`, `effectiveDate`, `source`.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.92' },
  },
  {
    slug: 'vat-returns',
    title: 'VAT returns',
    lead:
      'Periodic VAT / sales-tax filing records. Mutations require the `vat_returns:write` scope; reads require `vat_returns:read`.',
    endpoint: 'vat-returns',
    scope: 'vat_returns',
    idPrefix: 'vat',
    resourceSingular: 'VAT return',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `vat_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'periodStart', type: 'string', description: 'Filing period start.' },
      { name: 'periodEnd', type: 'string', description: 'Filing period end.' },
      { name: 'status', type: 'string', description: 'Draft, submitted, etc.' },
      { name: 'totalVat', type: 'string', description: 'Net VAT due (decimal string).' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Optional: `entityId`, `periodStart`, `periodEnd`, `jurisdiction`, totals. Calculate, file, and XML endpoints are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', periodStart: '2024-10-01', periodEnd: '2024-12-31' },
  },
  {
    slug: 'accounting-documents',
    title: 'Accounting documents',
    lead:
      'Scanned receipts, statements, and other supporting files. Mutations require the `accounting_documents:write` scope; reads require `accounting_documents:read`.',
    endpoint: 'accounting-documents',
    scope: 'accounting_documents',
    idPrefix: 'doc',
    resourceSingular: 'accounting document',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `doc_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'fileName', type: 'string', description: 'Original file name.' },
      { name: 'contentType', type: 'string', description: 'MIME type.' },
      { name: 'url', type: 'string', description: 'Download URL (if stored).' },
      { name: 'status', type: 'string', description: 'Processing status.' },
      { name: 'attachedToType', type: 'string', description: 'Linked entity type (bill, invoice, …).' },
      { name: 'attachedToId', type: 'string', description: 'Linked entity id.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'fileName', type: 'string', description: 'File name.' }],
    createOptionalNote:
      'Optional: `entityId`, `contentType`, `url`, `storageKey`, `attachedToType`, `attachedToId`. OCR and process flows are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', fileName: 'receipt-jan.pdf', contentType: 'application/pdf' },
  },
  {
    slug: 'icp-declarations',
    title: 'ICP declarations',
    lead:
      'Intracommunity supply declarations (NL ICP / EU B2B listings). Mutations require the `icp_declarations:write` scope; reads require `icp_declarations:read`.',
    endpoint: 'icp-declarations',
    scope: 'icp_declarations',
    idPrefix: 'icp',
    resourceSingular: 'ICP declaration',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `icp_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'periodStart', type: 'string', description: 'Declaration period start.' },
      { name: 'periodEnd', type: 'string', description: 'Declaration period end.' },
      { name: 'periodType', type: 'string', description: '`monthly`, `quarterly`, or `yearly`.' },
      { name: 'status', type: 'string', description: 'Draft or filed.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [
      { name: 'entityId', type: 'string', description: 'Accounting entity id.' },
      { name: 'periodStart', type: 'string', description: 'Period start date.' },
      { name: 'periodEnd', type: 'string', description: 'Period end date.' },
    ],
    createOptionalNote: 'Optional: `periodType`, `periodLabel`, `status`. Calculate, file, and XML endpoints are on the app API.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
    createExample: { entityId: 'ent_abc123', periodStart: '2024-01-01', periodEnd: '2024-01-31', periodType: 'monthly' },
  },
]

function propsBlock(properties) {
  return properties
    .map(
      (p) =>
        `  <Property name="${p.name}" type="${p.type}">${p.description}</Property>`,
    )
    .join('\n')
}

function jsonExample(obj) {
  return JSON.stringify(obj, null, 2)
}

function listTitle(config) {
  return `List ${config.title.toLowerCase()}`
}

function createTitle(config) {
  const s = config.resourceSingular
  return `Create ${/^([aeiouAEIOU])/.test(s) ? 'an' : 'a'} ${s}`
}

function retrieveTitle(config) {
  const s = config.resourceSingular
  return `Retrieve ${/^([aeiouAEIOU])/.test(s) ? 'an' : 'a'} ${s}`
}

function updateTitle(config) {
  const s = config.resourceSingular
  return `Update ${/^([aeiouAEIOU])/.test(s) ? 'an' : 'a'} ${s}`
}

function deleteTitle(config) {
  const s = config.resourceSingular
  return `Delete ${/^([aeiouAEIOU])/.test(s) ? 'an' : 'a'} ${s}`
}

function generateCrudMdx(config) {
  const path = `${API}/${config.endpoint}`
  const exampleId = `${config.idPrefix}_abc123`
  const newId = `${config.idPrefix}_new456`
  const listPath = `/v1/${config.endpoint}`
  const createBody = jsonExample(config.createExample ?? {})

  const createColParts = [`Create ${/^([aeiouAEIOU])/.test(config.resourceSingular) ? 'an' : 'a'} ${config.resourceSingular}.`]
  if (config.createRequired?.length) {
    createColParts.push('', '### Required attributes', '', '<Properties>', propsBlock(config.createRequired), '</Properties>')
  }
  if (config.createOptionalNote) {
    createColParts.push('', config.createOptionalNote)
  }

  return `# ${config.title}

${config.lead} {{ className: 'lead' }}

<ResourceVersionBanner />

---

## The ${config.resourceSingular} model

### Properties

<Properties>
${propsBlock(config.modelProperties)}
</Properties>

---

## ${listTitle(config)} {{ tag: 'GET', label: '${listPath}' }}

<Row>
  <Col>

    Retrieve a cursor-paginated list. ${config.listQueryNote ?? 'Optional query parameters: `limit`, `cursor`.'}

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="GET" label="${listPath}">

    \`\`\`bash {{ title: 'cURL' }}
    curl -G ${path} \\
      -H "Authorization: Bearer wsk_your_api_key"
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": [
        { "id": "${exampleId}" }
      ],
      "pagination": { "totalCount": 1, "hasMore": false, "cursor": null }
    }
    \`\`\`

  </Col>
</Row>

---

## ${createTitle(config)} {{ tag: 'POST', label: '${listPath}' }}

<Row>
  <Col>

    ${createColParts.join('\n    ')}

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="POST" label="${listPath}">

    \`\`\`bash {{ title: 'cURL' }}
    curl ${path} \\
      -H "Authorization: Bearer wsk_your_api_key" \\
      -H "Content-Type: application/json" \\
      -d '${createBody.replace(/\n/g, '\n      ')}'
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": {
        "id": "${newId}",
        "createdAt": "2024-12-01T14:00:00Z",
        "updatedAt": "2024-12-01T14:00:00Z"
      }
    }
    \`\`\`

  </Col>
</Row>

---

## ${retrieveTitle(config)} {{ tag: 'GET', label: '${listPath}/:id' }}

<Row>
  <Col>

    Retrieve a single ${config.resourceSingular} by ID.

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="GET" label="${listPath}/${exampleId}">

    \`\`\`bash {{ title: 'cURL' }}
    curl ${path}/${exampleId} \\
      -H "Authorization: Bearer wsk_your_api_key"
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": {
        "id": "${exampleId}"
      }
    }
    \`\`\`

  </Col>
</Row>

---

## ${updateTitle(config)} {{ tag: 'PATCH', label: '${listPath}/:id' }}

<Row>
  <Col>

    Partially update a ${config.resourceSingular}. Only the fields you send are changed.

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="PATCH" label="${listPath}/${exampleId}">

    \`\`\`bash {{ title: 'cURL' }}
    curl -X PATCH ${path}/${exampleId} \\
      -H "Authorization: Bearer wsk_your_api_key" \\
      -H "Content-Type: application/json" \\
      -d '{}'
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": {
        "id": "${exampleId}",
        "updatedAt": "2024-12-01T15:00:00Z"
      }
    }
    \`\`\`

  </Col>
</Row>

---

## ${deleteTitle(config)} {{ tag: 'DELETE', label: '${listPath}/:id' }}

<Row>
  <Col>

    Soft-delete a ${config.resourceSingular}. Returns \`204 No Content\`.

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="DELETE" label="${listPath}/${exampleId}">

    \`\`\`bash {{ title: 'cURL' }}
    curl -X DELETE ${path}/${exampleId} \\
      -H "Authorization: Bearer wsk_your_api_key"
    \`\`\`

    </CodeGroup>

    \`\`\`text {{ title: 'Response' }}
    204 No Content
    \`\`\`

  </Col>
</Row>
`
}

function generateSettingsMdx() {
  return `# Accounting settings

Workspace-wide WeldBooks defaults (singleton row). There is at most one settings record per workspace. Mutations require the \`accounting_settings:write\` scope; reads require \`accounting_settings:read\`. {{ className: 'lead' }}

<ResourceVersionBanner />

---

## The settings model

### Properties

<Properties>
  <Property name="id" type="string">Unique identifier (e.g. \`acs_abc123\`).</Property>
  <Property name="defaultEntityId" type="string">Default accounting entity for new documents.</Property>
  <Property name="fiscalYearStart" type="number">Month the fiscal year starts (1–12).</Property>
  <Property name="accountingMethod" type="string">\`accrual\` or \`cash\`.</Property>
  <Property name="defaultPaymentTermsDays" type="number">Default payment terms in days.</Property>
  <Property name="emailSettings" type="object">Inbox automation settings for document scanning.</Property>
  <Property name="updatedAt" type="timestamp">When last updated.</Property>
</Properties>

---

## Retrieve settings {{ tag: 'GET', label: '/v1/accounting-settings' }}

<Row>
  <Col>

    Returns the workspace settings row. If none exists yet, the API creates a default row and returns it with \`201\`.

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="GET" label="/v1/accounting-settings">

    \`\`\`bash {{ title: 'cURL' }}
    curl ${API}/accounting-settings \\
      -H "Authorization: Bearer wsk_your_api_key"
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": {
        "id": "acs_abc123",
        "defaultPaymentTermsDays": 30,
        "accountingMethod": "accrual",
        "fiscalYearStart": 1
      }
    }
    \`\`\`

  </Col>
</Row>

---

## Update settings {{ tag: 'PATCH', label: '/v1/accounting-settings' }}

<Row>
  <Col>

    Partially update workspace accounting settings. Only the fields you send are changed.

    ### Optional attributes

    <Properties>
      <Property name="defaultEntityId" type="string">Default entity id.</Property>
      <Property name="fiscalYearStart" type="number">Fiscal year start month.</Property>
      <Property name="accountingMethod" type="string">Accrual or cash.</Property>
      <Property name="defaultPaymentTermsDays" type="number">Default payment terms.</Property>
      <Property name="emailSettings" type="object">Inbox / OCR automation toggles.</Property>
    </Properties>

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="PATCH" label="/v1/accounting-settings">

    \`\`\`bash {{ title: 'cURL' }}
    curl -X PATCH ${API}/accounting-settings \\
      -H "Authorization: Bearer wsk_your_api_key" \\
      -H "Content-Type: application/json" \\
      -d '{ "defaultPaymentTermsDays": 14 }'
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": {
        "id": "acs_abc123",
        "defaultPaymentTermsDays": 14,
        "updatedAt": "2024-12-01T15:00:00Z"
      }
    }
    \`\`\`

  </Col>
</Row>
`
}

function layoutTsx(title, description) {
  return `import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: '${title}',
  description: '${description.replace(/'/g, "\\'")}',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
`
}

for (const config of configs) {
  const dir = path.join(appDir, config.slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'page.mdx'), generateCrudMdx(config))
  fs.writeFileSync(
    path.join(dir, 'layout.tsx'),
    layoutTsx(
      config.title,
      `On this page, we dive into the ${config.title.toLowerCase()} endpoints you can use to manage WeldBooks data programmatically.`,
    ),
  )
  const tsx = path.join(dir, 'page.tsx')
  if (fs.existsSync(tsx)) fs.unlinkSync(tsx)
}

{
  const dir = path.join(appDir, 'accounting-settings')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'page.mdx'), generateSettingsMdx())
  fs.writeFileSync(
    path.join(dir, 'layout.tsx'),
    layoutTsx(
      'Accounting settings',
      'Read and update workspace-wide WeldBooks settings via the external API.',
    ),
  )
  const tsx = path.join(dir, 'page.tsx')
  if (fs.existsSync(tsx)) fs.unlinkSync(tsx)
}

console.log(`Generated ${configs.length + 1} MDX doc pages`)
