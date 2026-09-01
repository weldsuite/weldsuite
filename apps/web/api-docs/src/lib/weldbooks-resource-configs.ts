export interface DocProperty {
  name: string
  type: string
  description: string
}

export interface CrudResourceDocConfig {
  slug: string
  title: string
  lead: string
  /** URL segment under /v1, e.g. `invoices`. */
  endpoint: string
  /** Scope namespace, e.g. `invoices` → `invoices:read`. */
  scope: string
  /** Example id prefix in docs, e.g. `inv`. */
  idPrefix: string
  resourceSingular: string
  modelProperties: DocProperty[]
  createRequired?: DocProperty[]
  createOptionalNote?: string
  listQueryNote?: string
  extraNotes?: string
}

export const WELDBOOKS_RESOURCE_CONFIGS: Record<string, CrudResourceDocConfig> = {
  'accounting-entities': {
    slug: 'accounting-entities',
    title: 'Accounting entities',
    lead:
      'Legal entities (companies) in WeldBooks — each has its own chart of accounts, tax rates, and books. Mutations require `accounting_entities:write`; reads require `accounting_entities:read`.',
    endpoint: 'accounting-entities',
    scope: 'accounting_entities',
    idPrefix: 'ent',
    resourceSingular: 'accounting entity',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `ent_abc123`).' },
      { name: 'name', type: 'string', description: 'Display name of the entity.' },
      { name: 'legalName', type: 'string', description: 'Registered legal name.' },
      { name: 'jurisdictionCode', type: 'string', description: 'ISO country/jurisdiction code (e.g. `NL`, `BE`).' },
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
    listQueryNote: 'Optional: `limit`, `cursor`.',
  },
  'gl-accounts': {
    slug: 'gl-accounts',
    title: 'GL accounts',
    lead:
      'Chart-of-accounts lines (general ledger). Mutations require `gl_accounts:write`; reads require `gl_accounts:read`.',
    endpoint: 'gl-accounts',
    scope: 'gl_accounts',
    idPrefix: 'acc',
    resourceSingular: 'GL account',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `acc_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'code', type: 'string', description: 'Account code.' },
      { name: 'name', type: 'string', description: 'Account name.' },
      { name: 'type', type: 'string', description: 'Account type (asset, liability, equity, revenue, expense).' },
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId` (filter by accounting entity).',
  },
  invoices: {
    slug: 'invoices',
    title: 'Invoices',
    lead:
      'Customer invoices (accounts receivable). Mutations require `invoices:write`; reads require `invoices:read`.',
    endpoint: 'invoices',
    scope: 'invoices',
    idPrefix: 'inv',
    resourceSingular: 'invoice',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `inv_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'invoiceNumber', type: 'string', description: 'Human-readable invoice number.' },
      { name: 'status', type: 'string', description: 'Lifecycle status (e.g. `draft`, `sent`, `paid`).' },
      { name: 'contactId', type: 'string', description: 'Customer / accounting contact.' },
      { name: 'issueDate', type: 'string', description: 'Issue date.' },
      { name: 'dueDate', type: 'string', description: 'Due date.' },
      { name: 'currency', type: 'string', description: 'Invoice currency.' },
      { name: 'subtotal', type: 'string', description: 'Subtotal (decimal string).' },
      { name: 'taxTotal', type: 'string', description: 'Tax total (decimal string).' },
      { name: 'total', type: 'string', description: 'Grand total (decimal string).' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote:
      'Common fields: `entityId`, `customerId`, `customerName`, `reference`, `issueDate`, `dueDate`, `currency`, line items via `items` (passthrough). Complex workflows (finalize, send, PDF) are available on the first-party app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  bills: {
    slug: 'bills',
    title: 'Bills',
    lead:
      'Supplier bills (accounts payable). Mutations require `bills:write`; reads require `bills:read`.',
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
      'Common fields: `entityId`, `supplierId`, `supplierName`, `reference`, `issueDate`, `dueDate`, `currency`, `items` (passthrough). Approval workflows remain on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'journal-entries': {
    slug: 'journal-entries',
    title: 'Journal entries',
    lead:
      'Manual double-entry journal entries. Mutations require `journal_entries:write`; reads require `journal_entries:read`.',
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
      'Optional: `entityId`, `reference`, `description`, `date`, `lines` (debit/credit lines, passthrough). Post/reverse actions are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  payments: {
    slug: 'payments',
    title: 'Payments',
    lead:
      'Payments applied to invoices or bills. Mutations require `payments:write`; reads require `payments:read`.',
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'bank-accounts': {
    slug: 'bank-accounts',
    title: 'Bank accounts',
    lead:
      'Bank accounts linked to the general ledger. Mutations require `bank_accounts:write`; reads require `bank_accounts:read`.',
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'bank-transactions': {
    slug: 'bank-transactions',
    title: 'Bank transactions',
    lead:
      'Imported or manual bank statement lines. Mutations require `bank_transactions:write`; reads require `bank_transactions:read`.',
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
      'Optional: `entityId`, `bankAccountId`, `amount`, `currency`, `transactionDate`, `reference`, `counterpartyName`. Import/reconcile flows are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'accounting-contacts': {
    slug: 'accounting-contacts',
    title: 'Accounting contacts',
    lead:
      'Customers and suppliers used on invoices and bills (backed by the unified `parties` layer). Mutations require `accounting_contacts:write`; reads require `accounting_contacts:read`.',
    endpoint: 'accounting-contacts',
    scope: 'accounting_contacts',
    idPrefix: 'acn',
    resourceSingular: 'accounting contact',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `acn_abc123`).' },
      { name: 'name', type: 'string', description: 'Contact display name (maps to `displayName`).' },
      { name: 'type', type: 'string', description: 'Role: `customer`, `supplier`, or `both` (maps to `role`).' },
      { name: 'email', type: 'string', description: 'Email address.' },
      { name: 'phone', type: 'string', description: 'Phone number.' },
      { name: 'taxNumber', type: 'string', description: 'VAT / tax number (request alias).' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createRequired: [{ name: 'name', type: 'string', description: 'Contact name.' }],
    createOptionalNote: 'Optional: `type`, `email`, `phone`, `taxNumber`, `isActive`.',
    listQueryNote: 'Optional: `limit`, `cursor`, `search`, `role`.',
  },
  'tax-rates': {
    slug: 'tax-rates',
    title: 'Tax rates',
    lead:
      'VAT / GST rate definitions per entity. Mutations require `tax_rates:write`; reads require `tax_rates:read`.',
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'recurring-invoices': {
    slug: 'recurring-invoices',
    title: 'Recurring invoices',
    lead:
      'Scheduled invoice templates. Mutations require `recurring_invoices:write`; reads require `recurring_invoices:read`.',
    endpoint: 'recurring-invoices',
    scope: 'recurring_invoices',
    idPrefix: 'ri',
    resourceSingular: 'recurring invoice',
    modelProperties: [
      { name: 'id', type: 'string', description: 'Unique identifier (e.g. `ri_abc123`).' },
      { name: 'entityId', type: 'string', description: 'Owning accounting entity.' },
      { name: 'contactId', type: 'string', description: 'Customer contact.' },
      { name: 'frequency', type: 'string', description: 'Billing frequency.' },
      { name: 'status', type: 'string', description: 'Active / paused.' },
      { name: 'nextRunDate', type: 'string', description: 'Next generation date.' },
      { name: 'createdAt', type: 'timestamp', description: 'When created.' },
      { name: 'updatedAt', type: 'timestamp', description: 'When last updated.' },
    ],
    createOptionalNote: 'Optional: `entityId`, `contactId`, `frequency`, `currency`, template line items (passthrough). Generate/pause actions are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'reconciliation-rules': {
    slug: 'reconciliation-rules',
    title: 'Reconciliation rules',
    lead:
      'Rules that auto-match bank transactions to ledger entries. Mutations require `reconciliation_rules:write`; reads require `reconciliation_rules:read`.',
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'fiscal-periods': {
    slug: 'fiscal-periods',
    title: 'Fiscal periods',
    lead:
      'Open / closed accounting periods. Mutations require `fiscal_periods:write`; reads require `fiscal_periods:read`.',
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
    createOptionalNote: 'Optional: `entityId`, `status`, `type`. Close/reopen actions are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'fx-rates': {
    slug: 'fx-rates',
    title: 'FX rates',
    lead:
      'Exchange rates for multi-currency bookkeeping. Mutations require `fx_rates:write`; reads require `fx_rates:read`.',
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
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'vat-returns': {
    slug: 'vat-returns',
    title: 'VAT returns',
    lead:
      'Periodic VAT / sales-tax filing records. Mutations require `vat_returns:write`; reads require `vat_returns:read`.',
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
      'Optional: `entityId`, `periodStart`, `periodEnd`, `jurisdiction`, totals. Calculate/file/XML endpoints are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'accounting-documents': {
    slug: 'accounting-documents',
    title: 'Accounting documents',
    lead:
      'Scanned receipts, statements, and other supporting files. Mutations require `accounting_documents:write`; reads require `accounting_documents:read`.',
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
    createOptionalNote: 'Optional: `entityId`, `contentType`, `url`, `storageKey`, `attachedToType`, `attachedToId`. OCR/process flows are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
  'icp-declarations': {
    slug: 'icp-declarations',
    title: 'ICP declarations',
    lead:
      'Intracommunity supply declarations (NL ICP / EU B2B listings). Mutations require `icp_declarations:write`; reads require `icp_declarations:read`.',
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
    createOptionalNote: 'Optional: `periodType`, `periodLabel`, `status`. Calculate/file/XML endpoints are on the app API.',
    listQueryNote: 'Optional: `limit`, `cursor`, `entityId`.',
  },
}

export const WELDBOOKS_NAV_LINKS = Object.values(WELDBOOKS_RESOURCE_CONFIGS).map((c) => ({
  title: c.title,
  href: `/${c.slug}`,
}))
