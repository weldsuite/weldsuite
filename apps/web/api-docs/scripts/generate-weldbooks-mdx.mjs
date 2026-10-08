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
      'Legal entities in WeldBooks — each has its own chart of accounts, tax rates, and books. Reads require the `accounting_entities:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`.',
  },
  {
    slug: 'gl-accounts',
    title: 'GL accounts',
    lead:
      'Chart-of-accounts lines (general ledger). Reads require the `gl_accounts:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'invoices',
    title: 'Invoices',
    lead:
      'Customer invoices (accounts receivable). Reads require the `invoices:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'bills',
    title: 'Bills',
    lead:
      'Supplier bills (accounts payable). Reads require the `bills:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'journal-entries',
    title: 'Journal entries',
    lead:
      'Manual double-entry journal entries. Reads require the `journal_entries:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'payments',
    title: 'Payments',
    lead:
      'Payments applied to invoices or bills. Reads require the `payments:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'bank-accounts',
    title: 'Bank accounts',
    lead:
      'Bank accounts linked to the general ledger. Reads require the `bank_accounts:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'bank-transactions',
    title: 'Bank transactions',
    lead:
      'Imported or manual bank statement lines. Reads require the `bank_transactions:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
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
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'name', type: 'string', description: 'Contact name.' }],
    createOptionalNote:
      'Optional: `type` (defaults to `customer`). The public API stores the `name` and `type` of a contact only and ignores any other field; email, phone, tax numbers, addresses and ledger defaults are set in WeldBooks.',
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `search`, `role`.',
    createExample: { name: 'Smith Industries', type: 'customer' },
  },
  {
    slug: 'tax-rates',
    title: 'Tax rates',
    lead:
      'VAT / GST rate definitions per entity. Reads require the `tax_rates:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'recurring-invoices',
    title: 'Recurring invoices',
    lead:
      'Scheduled invoice templates. Reads require the `recurring_invoices:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'reconciliation-rules',
    title: 'Reconciliation rules',
    lead:
      'Rules that auto-match bank transactions to ledger entries. Reads require the `reconciliation_rules:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'fiscal-periods',
    title: 'Fiscal periods',
    lead:
      'Open / closed accounting periods. Reads require the `fiscal_periods:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'fx-rates',
    title: 'FX rates',
    lead:
      'Exchange rates for multi-currency bookkeeping. Reads require the `fx_rates:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'vat-returns',
    title: 'VAT returns',
    lead:
      'Periodic VAT / sales-tax filing records. Reads require the `vat_returns:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'accounting-documents',
    title: 'Accounting documents',
    lead:
      'Scanned receipts, statements, and other supporting files. Reads require the `accounting_documents:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
  {
    slug: 'icp-declarations',
    title: 'ICP declarations',
    lead:
      'Intracommunity supply declarations (NL ICP / EU B2B listings). Reads require the `icp_declarations:read` scope.',
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
    listQueryNote: 'Optional query parameters: `limit`, `cursor`, `entityId`.',
  },
]

const WORKSPACE_SCOPED = new Set(['accounting-entities', 'accounting-contacts'])

function isEntityScoped(config) {
  return !WORKSPACE_SCOPED.has(config.slug)
}

/**
 * WeldBooks resources the public API serves for reading only, with the one
 * sentence on why that goes on each page. Writes answer 405. The ledger changes
 * only through WeldBooks, where tax is calculated, documents are numbered and
 * posted, periods and lock dates are enforced and the audit log is written.
 * Keep in sync with READ_ONLY_SEGMENTS in apps/workers/external-api
 * (src/test/entities.ts) and the routes in src/routes/v1/accounting.
 * Accounting contacts are the only writable resource.
 */
const READ_ONLY_REASONS = {
  'accounting-entities':
    'a new entity needs its chart of accounts, tax rates and jurisdiction defaults set up, which only WeldBooks does',
  'gl-accounts':
    'every posting depends on the chart of accounts, so changes to it are made in WeldBooks, where they are checked and written to the audit log',
  invoices:
    'every invoice and credit note is tax-calculated, numbered and posted to the ledger in WeldBooks, and a write that skips those steps would leave the books out of balance',
  bills:
    'every bill is tax-calculated and posted to the ledger in WeldBooks, and a write that skips those steps would leave the books out of balance',
  'journal-entries':
    'every journal entry is checked for balance, fiscal period and lock dates and posted to the ledger in WeldBooks',
  payments:
    'every payment is posted against receivables or payables and allocated to its documents in WeldBooks',
  'bank-accounts':
    'each bank account is tied to the ledger account its payments post to, which WeldBooks sets up and checks',
  'bank-transactions':
    'imported bank lines are categorised, matched to documents and posted in WeldBooks',
  'tax-rates':
    'tax rates drive tax calculation and the tax ledger, so WeldBooks validates every change',
  'recurring-invoices':
    'each invoice a schedule generates has to be tax-calculated and posted in WeldBooks',
  'reconciliation-rules':
    'rules decide which ledger and tax accounts bank lines are posted to, and WeldBooks validates them',
  'fiscal-periods':
    'periods and lock dates control what can still be posted, so they are managed in WeldBooks',
  'fx-rates':
    'exchange rates drive currency conversion on posted documents, and WeldBooks maintains them',
  'vat-returns':
    'returns are built from the tax ledger and filed from WeldBooks',
  'icp-declarations':
    'declarations are built from the tax ledger and filed from WeldBooks',
  'accounting-documents':
    'the document inbox (OCR, vendor matching, linking to bills and invoices) runs in WeldBooks, and the public API has no way to upload the file a document points at',
  'accounting-settings':
    'settings such as the default entity and the accounting method change how the books are reported, so they are managed in WeldBooks',
}

function isReadOnly(config) {
  return Object.hasOwn(READ_ONLY_REASONS, config.slug)
}

/** The "Read-only resource" section at the top of a read-only resource page. */
function readOnlySection(slug, title, endpoint) {
  return `---

## Read-only resource

${title} are read-only through the public API because ${READ_ONLY_REASONS[slug]}. \`POST\`, \`PUT\`, \`PATCH\` and \`DELETE\` on \`/v1/${endpoint}\` answer \`405 METHOD_NOT_ALLOWED\`; make changes in WeldBooks.

`
}

const PAGINATION_FILTERS = [
  {
    name: 'limit',
    type: 'integer',
    description:
      'Number of items to return. Minimum 1, maximum 200. Defaults to a server-side value (typically 25). See [Pagination](/pagination).',
  },
  {
    name: 'cursor',
    type: 'string',
    description:
      'Opaque cursor from `pagination.cursor` on the previous page. Omit for the first page.',
  },
]

const ENTITY_FILTER = {
  name: 'entityId',
  type: 'string',
  description:
    'Filter to records belonging to one accounting entity (`ent_*`). Omit to list across all entities in the workspace.',
}

function getListFilters(config) {
  if (config.listFilters) return config.listFilters
  const filters = [...PAGINATION_FILTERS]
  if (isEntityScoped(config)) filters.push(ENTITY_FILTER)
  if (config.slug === 'accounting-contacts') {
    filters.push(
      {
        name: 'search',
        type: 'string',
        description: 'Case-insensitive match against contact name and party code.',
      },
      {
        name: 'role',
        type: 'string',
        description: 'Filter by role: `customer`, `supplier`, or `both`.',
      },
    )
  }
  return filters
}

function entityScopingSection(config) {
  if (config.slug === 'accounting-entities') {
    return `---

## Multi-entity workspaces

An **accounting entity** is a legal company (a set of books) inside your workspace. Most WeldBooks resources — bills, invoices, bank accounts, tax rates, and so on — carry an \`entityId\` that points here.

Use this endpoint to list entities, read \`isDefault\`, and resolve ids to filter entity-scoped records. Workspace-wide defaults (including \`defaultEntityId\`) live on [accounting settings](/accounting-settings).

`
  }
  if (config.slug === 'accounting-contacts') {
    return `---

## Workspace scope

Accounting contacts are **workspace-wide** — they are not tied to a single accounting entity. Customers and suppliers are shared; bills and invoices link to them via \`contactId\` / \`supplierId\` while the document itself is scoped with \`entityId\`.

`
  }
  if (!isEntityScoped(config)) return ''
  return `---

## Accounting entity scoping

Every ${config.resourceSingular} belongs to one **accounting entity** (legal company / set of books). The \`entityId\` field on each record references an [accounting entity](/accounting-entities) (\`ent_*\`).

- **On read:** responses include \`entityId\` — that is how you know which books a record belongs to.
- **On list:** pass \`?entityId=ent_abc123\` to restrict results to one entity. To find the id, read \`defaultEntityId\` from [accounting settings](/accounting-settings), or list [accounting entities](/accounting-entities) and use the row with \`isDefault: true\`.

`
}

function listCurlExample(config) {
  const path = `${API}/${config.endpoint}`
  const lines = [
    `curl -G ${path} \\`,
    '  -H "Authorization: Bearer wsk_your_api_key" \\',
  ]
  if (isEntityScoped(config)) {
    lines.push('  -d entityId=ent_abc123 \\')
  }
  if (config.slug === 'accounting-contacts') {
    lines.push('  -d role=supplier \\')
  }
  lines.push('  -d limit=25')
  return lines.join('\n    ')
}

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

/**
 * Create, update and delete sections. Only writable resources have them, and
 * accounting contacts are the only one: they are workspace-wide, so there is no
 * `entityId` to send.
 */
function writeSections(config) {
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

  return {
    create: `---

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
      -d '${createBody.replaceAll('\n', '\n      ')}'
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

`,
    updateAndDelete: `
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
`,
  }
}

function generateCrudMdx(config) {
  const path = `${API}/${config.endpoint}`
  const exampleId = `${config.idPrefix}_abc123`
  const entId = 'ent_abc123'
  const listPath = `/v1/${config.endpoint}`
  const listFilters = getListFilters(config)
  const readOnly = isReadOnly(config)
  const writes = readOnly ? { create: '', updateAndDelete: '' } : writeSections(config)

  const listResponseEntity = isEntityScoped(config)
    ? `{ "id": "${exampleId}", "entityId": "${entId}" }`
    : `{ "id": "${exampleId}" }`

  const retrieveResponse = isEntityScoped(config)
    ? `{
        "id": "${exampleId}",
        "entityId": "${entId}"
      }`
    : `{
        "id": "${exampleId}"
      }`

  return `# ${config.title}

${config.lead} {{ className: 'lead' }}

<ResourceVersionBanner />

${readOnly ? readOnlySection(config.slug, config.title, config.endpoint) : ''}${entityScopingSection(config)}---

## The ${config.resourceSingular} model

### Properties

<Properties>
${propsBlock(config.modelProperties)}
</Properties>

---

## ${listTitle(config)} {{ tag: 'GET', label: '${listPath}' }}

<Row>
  <Col>

    Retrieve a cursor-paginated list. All list endpoints accept the query parameters below. See [Pagination](/pagination) for cursor semantics.

    ### Query parameters

    <Properties>
${propsBlock(listFilters).replaceAll(/^/gm, '    ')}
    </Properties>

  </Col>
  <Col sticky>

    <CodeGroup title="Request" tag="GET" label="${listPath}">

    \`\`\`bash {{ title: 'cURL' }}
    ${listCurlExample(config)}
    \`\`\`

    </CodeGroup>

    \`\`\`json {{ title: 'Response' }}
    {
      "data": [
        ${listResponseEntity}
      ],
      "pagination": { "totalCount": 1, "hasMore": false, "cursor": null }
    }
    \`\`\`

  </Col>
</Row>

${writes.create}---

## ${retrieveTitle(config)} {{ tag: 'GET', label: '${listPath}/:id' }}

<Row>
  <Col>

    Retrieve a single ${config.resourceSingular} by ID.${isEntityScoped(config) ? ' The response includes `entityId` so you can tell which accounting entity owns the record.' : ''}

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
      "data": ${retrieveResponse}
    }
    \`\`\`

  </Col>
</Row>
${writes.updateAndDelete}`
}

function generateSettingsMdx() {
  return `# Accounting settings

Workspace-wide WeldBooks defaults (singleton row). There is at most one settings record per workspace. Reads require the \`accounting_settings:read\` scope. {{ className: 'lead' }}

<ResourceVersionBanner />

${readOnlySection('accounting-settings', 'Accounting settings', 'accounting-settings')}---

## Role in the data model

This endpoint does **not** list multiple rows — it returns the single settings object for your workspace. Use it to read **\`defaultEntityId\`**, the accounting entity id integrations should prefer when filtering bills, invoices, and other entity-scoped records.

Pair this with [accounting entities](/accounting-entities) (\`GET /v1/accounting-entities\`) to resolve entity names, jurisdictions, and the \`isDefault\` flag. See the [WeldBooks overview](/weldbooks) for the full entity-scoping model.

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

    Returns the workspace settings row. WeldBooks creates it when the workspace first uses WeldBooks accounting; until then the endpoint returns \`404\`.

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
`
}

function generateOverviewMdx() {
  const entityScopedRows = configs
    .filter((c) => isEntityScoped(c))
    .map(
      (c) =>
        `| [${c.title}](/${c.slug}) | \`${c.scope}:read\` | \`entityId\` on every record; filter lists with \`?entityId=\` |`,
    )
    .join('\n')

  return `# WeldBooks

WeldBooks is WeldSuite's accounting module exposed on the external API. A workspace can contain **multiple accounting entities** (legal companies), each with its own chart of accounts, tax rates, bank accounts, and documents. Most API resources are scoped to one entity via \`entityId\`. {{ className: 'lead' }}

<ResourceVersionBanner />

---

## Data model

\`\`\`
Workspace
├── Accounting settings (singleton)     → defaultEntityId, fiscal defaults
├── Accounting contacts (workspace-wide) → customers & suppliers (shared)
└── Accounting entity (ent_*)
    ├── GL accounts, tax rates, fiscal periods
    ├── Bills, invoices, payments
    ├── Bank accounts & transactions
    └── VAT returns, documents, …
\`\`\`

**Entity-scoped records** (bills, invoices, bank accounts, …) include \`entityId\` in every response. That id tells you which legal entity owns the record.

**Workspace-scoped records** are [accounting entities](/accounting-entities) themselves and [accounting contacts](/accounting-contacts) (customers/suppliers used across entities).

---

## Discovering the right entity id

Typical integration flow:

1. \`GET /v1/accounting-settings\` — read \`defaultEntityId\` (\`404\` until the workspace has started using WeldBooks)
2. \`GET /v1/accounting-entities\` — list entities; confirm \`isDefault\` and read \`jurisdictionCode\` / \`baseCurrency\`
3. Use that \`ent_*\` id to filter entity-scoped resources

Example — list bills for one entity:

\`\`\`bash {{ title: 'Filter bills by entity' }}
curl -G https://api.weldsuite.org/v1/bills \\
  -H "Authorization: Bearer wsk_your_api_key" \\
  -d entityId=ent_abc123 \\
  -d limit=25
\`\`\`

---

## Read-only resources

WeldBooks keeps the ledger consistent. Tax is calculated, documents are numbered and posted to the journal, fiscal periods and lock dates are enforced, and every change is written to the audit log. All of that happens in WeldBooks, so the public API reads the books and does not write to them: every WeldBooks resource is **read-only**, except [accounting contacts](/accounting-contacts).

\`POST\`, \`PUT\`, \`PATCH\` and \`DELETE\` on a read-only resource return \`405\` with the standard error envelope and an \`Allow: GET, HEAD, OPTIONS\` header, whatever scopes the key holds:

\`\`\`json {{ title: '405 Method Not Allowed' }}
{
  "error": {
    "code": "METHOD_NOT_ALLOWED",
    "message": "The invoices resource is read-only through the public API. Create and change invoices in WeldBooks."
  }
}
\`\`\`

---

## Common list filters

All WeldBooks list endpoints support cursor [pagination](/pagination):

<Properties>
  <Property name="limit" type="integer">Items per page (1–200).</Property>
  <Property name="cursor" type="string">Cursor from the previous response's \`pagination.cursor\`.</Property>
</Properties>

**Entity-scoped endpoints** also accept:

<Properties>
  <Property name="entityId" type="string">Restrict results to one accounting entity (\`ent_*\`). Omit to search across all entities in the workspace.</Property>
</Properties>

**Accounting contacts** additionally accept \`search\` (name / party code) and \`role\` (\`customer\`, \`supplier\`, \`both\`). Contacts have no \`entityId\` filter because they are workspace-wide.

---

## Entity-scoped resources

| Resource | Scopes | \`entityId\` |
| --- | --- | --- |
${entityScopedRows}

---

## Workspace-scoped resources

| Resource | Scopes | Notes |
| --- | --- | --- |
| [Accounting entities](/accounting-entities) | \`accounting_entities:read\` | The entities themselves — root of the hierarchy |
| [Accounting contacts](/accounting-contacts) | \`accounting_contacts:read\` / \`:write\` | Shared customers/suppliers; filter with \`search\`, \`role\` |
| [Accounting settings](/accounting-settings) | \`accounting_settings:read\` | Singleton — no list endpoint |

---

## What you can change through the API

These docs cover the **external API** (\`api.weldsuite.org/v1\`). Reading is available for every WeldBooks resource. [Accounting contacts](/accounting-contacts) are the only resource you can create, update or delete, and only their name and role. Everything that changes the books happens in WeldBooks: creating and posting invoices, bills, payments and journal entries, approvals, bank import and reconciliation, VAT returns, and document OCR.
`
}

function layoutTsx(title, description) {
  return `import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: '${title}',
  description: '${description.replaceAll('\'', String.raw`\'`)}',
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
      isReadOnly(config)
        ? `On this page, we dive into the ${config.title.toLowerCase()} endpoints you can use to read WeldBooks data programmatically.`
        : `On this page, we dive into the ${config.title.toLowerCase()} endpoints you can use to manage WeldBooks data programmatically.`,
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
      'Read workspace-wide WeldBooks settings via the external API.',
    ),
  )
  const tsx = path.join(dir, 'page.tsx')
  if (fs.existsSync(tsx)) fs.unlinkSync(tsx)
}

{
  const dir = path.join(appDir, 'weldbooks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'page.mdx'), generateOverviewMdx())
  fs.writeFileSync(
    path.join(dir, 'layout.tsx'),
    layoutTsx(
      'WeldBooks',
      'Overview of WeldBooks on the external API — accounting entities, entityId scoping, list filters, and which resources are read-only.',
    ),
  )
}

console.log(`Generated ${configs.length + 2} MDX doc pages (including overview)`)
