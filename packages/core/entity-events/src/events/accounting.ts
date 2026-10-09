/**
 * WeldBooks entity events.
 *
 * Invoice subscription actions include `paid`, `overdue`, `sent` (derived
 * from invoice:updated + status changes inside agent-dispatch).
 */
export const ACCOUNTING_ENTITY_EVENTS = {
  account: ['created', 'updated', 'deleted', 'archived'],
  accounting_contact: ['created', 'updated', 'deleted', 'archived'],
  accounting_document: ['created', 'updated', 'deleted'],
  accounting_settings: ['updated'],
  bank_account: ['created', 'updated', 'deleted'],
  bank_transaction: ['created', 'updated', 'deleted', 'apply_reconciliation_rules'],
  bill: ['created', 'updated', 'deleted', 'approved', 'rejected', 'paid'],
  invoice: ['created', 'updated', 'deleted', 'paid', 'overdue', 'sent'],
  journal_entry: ['created', 'updated', 'deleted'],
  payment: ['created', 'updated', 'deleted'],
  purchase_order: ['created', 'updated', 'deleted', 'approved'],
  reconciliation_rule: ['created', 'updated', 'deleted'],
  recurring_invoice: ['created', 'updated', 'deleted'],
  tax_rate: ['created', 'updated', 'deleted'],
  vat_return: ['created', 'updated', 'deleted', 'submitted'],
  fiscal_period: ['created', 'updated', 'deleted', 'closed', 'reopened'],
  fx_rate: ['created', 'updated', 'deleted'],
  accounting_entity: ['created', 'updated', 'deleted'],
  // US accounting. Payloads never carry TINs, bank account numbers or provider tokens.
  sales_tax_agency: ['created', 'updated', 'deleted'],
  sales_tax_jurisdiction: ['created', 'updated', 'deleted'],
  sales_tax_zone: ['created', 'updated', 'deleted'],
  sales_tax_rule: ['created', 'updated', 'deleted'],
  tax_return: ['created', 'updated', 'deleted', 'filed', 'paid'],
  exemption_certificate: ['created', 'updated', 'deleted'],
  form_1099_filing: ['created', 'updated', 'deleted', 'generated', 'filed'],
  bank_connection: ['created', 'updated', 'deleted', 'synced'],
  bank_deposit: ['created', 'updated', 'deleted'],
  bank_reconciliation: ['created', 'updated', 'deleted', 'completed', 'undone'],
  payment_run: ['created', 'updated', 'deleted', 'approved', 'exported'],
  w9_request: ['created', 'updated', 'deleted', 'completed'],
  fixed_asset: ['created', 'updated', 'deleted', 'disposed'],
  accounting_dimension: ['created', 'updated', 'deleted'],
  payroll_import: ['created', 'updated', 'deleted'],
  payroll_connection: ['created', 'updated', 'deleted'],
} as const;
