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
} as const;
