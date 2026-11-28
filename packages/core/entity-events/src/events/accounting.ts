/**
 * WeldBooks entity events.
 *
 * Invoice subscription actions include `paid`, `overdue`, `sent` (derived
 * from invoice:updated + status changes inside agent-dispatch).
 */
export const ACCOUNTING_ENTITY_EVENTS = {
  account: ['created', 'updated', 'deleted', 'archived'],
  accounting_contact: ['created', 'updated', 'deleted', 'archived'],
  // `booked`: the document became a bill, receipt or credit note (Rust backend only,
  // edition feature `books-receipts`).
  accounting_document: ['created', 'updated', 'deleted', 'booked'],
  accounting_settings: ['updated'],
  // A question on a record, as a thread of its record chat (Rust backend only, edition feature
  // `books-questions`). `created` is asking; `updated` is a change of status (`from`, `status`):
  // answered by a reply or a receipt, resolved, re-opened. The id is the thread's first message.
  accounting_question: ['created', 'updated'],
  bank_account: ['created', 'updated', 'deleted'],
  // `processed` carries `how` (category, transfer, private, ignore, rule, auto, link);
  // `unprocessed` is the undo. Both Rust backend only (edition feature `books-bank-processing`).
  bank_transaction: ['created', 'updated', 'deleted', 'apply_reconciliation_rules', 'processed', 'unprocessed'],
  // `overdue`: the daily books sweep marked an approved bill past its due date (Rust backend only).
  bill: ['created', 'updated', 'deleted', 'approved', 'rejected', 'paid', 'overdue'],
  // `emailed`, `viewed` and `reminded` come from the Rust backend (edition features
  // `books-invoice-email` and `books-reminders`): the invoice went out by e-mail, its public
  // page was opened, a payment reminder went out.
  invoice: ['created', 'updated', 'deleted', 'paid', 'overdue', 'sent', 'emailed', 'viewed', 'reminded'],
  // A WeldCRM quote as WeldBooks sends and converts it (Rust backend only, edition feature
  // `books-quotes`). `accepted` is the customer accepting on the public page.
  quote: ['created', 'updated', 'deleted', 'accepted', 'emailed'],
  // `reviewed` and `unreviewed`: the accountant's review mark on a booking (Rust backend only,
  // edition feature `books-questions`). The mark is not a ledger change.
  journal_entry: ['created', 'updated', 'deleted', 'reviewed', 'unreviewed'],
  payment: ['created', 'updated', 'deleted'],
  // A legal entity's own Mollie account for online invoice payments (Rust backend only, edition
  // feature `books-online-payments`). `created` is connecting (OAuth or API key), `updated` the
  // enabled methods, `deleted` disconnecting. Events never carry a token or key.
  payment_connection: ['created', 'updated', 'deleted'],
  // `ordered`, `received`, `cancelled` and `closed` come from WeldStash's
  // purchase-order actions on the Rust backend (rust/modules/stash).
  purchase_order: ['created', 'updated', 'deleted', 'approved', 'ordered', 'received', 'cancelled', 'closed'],
  reconciliation_rule: ['created', 'updated', 'deleted'],
  recurring_invoice: ['created', 'updated', 'deleted'],
  tax_rate: ['created', 'updated', 'deleted'],
  vat_return: ['created', 'updated', 'deleted', 'submitted'],
  // The KvK jaarrekening (publicatiestukken), Rust backend only (rust/modules/books-reports).
  annual_report: ['created', 'updated', 'deleted', 'submitted'],
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
  // A SEPA credit-transfer batch for supplier bills (Rust backend only, edition feature
  // `books-sepa-batches`).
  payment_batch: ['created', 'cancelled'],
  w9_request: ['created', 'updated', 'deleted', 'completed'],
  fixed_asset: ['created', 'updated', 'deleted', 'disposed'],
  accounting_dimension: ['created', 'updated', 'deleted'],
  invoice_template: ['created', 'updated', 'deleted'],
  payroll_import: ['created', 'updated', 'deleted'],
  payroll_connection: ['created', 'updated', 'deleted'],
  // Brazil: NF-e / NFS-e issued through the fiscal provider, and NF-e received from suppliers.
  // Payloads never carry provider tokens, request bodies or XML.
  fiscal_document: ['created', 'updated', 'cancelled'],
  received_fiscal_document: ['created', 'updated'],
} as const;
