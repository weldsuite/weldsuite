CREATE TABLE "settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"fiscal_year_start" integer DEFAULT 1,
	"default_currency" varchar(3) DEFAULT 'EUR',
	"country" varchar(2) DEFAULT 'NL',
	"accounting_method" varchar(10) DEFAULT 'accrual',
	"default_payment_terms_days" integer DEFAULT 30,
	"invoice_number_prefix" varchar(20) DEFAULT 'INV-',
	"invoice_number_next" integer DEFAULT 1,
	"bill_number_prefix" varchar(20) DEFAULT 'BILL-',
	"bill_number_next" integer DEFAULT 1,
	"credit_note_number_prefix" varchar(20) DEFAULT 'CN-',
	"credit_note_number_next" integer DEFAULT 1,
	"journal_number_prefix" varchar(20) DEFAULT 'JE-',
	"journal_number_next" integer DEFAULT 1,
	"company_details" jsonb,
	"tax_settings" jsonb,
	"email_settings" jsonb,
	"invoice_template_settings" jsonb,
	"digipoort_settings" jsonb
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(50) NOT NULL,
	"type" varchar(10) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"closed_at" timestamp,
	"closed_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"code" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(20) NOT NULL,
	"subtype" varchar(50),
	"parent_account_id" varchar(30),
	"currency" varchar(3) DEFAULT 'EUR',
	"is_active" boolean DEFAULT true,
	"is_system_account" boolean DEFAULT false,
	"opening_balance" numeric(18, 2) DEFAULT '0',
	"current_balance" numeric(18, 2) DEFAULT '0',
	"normal_side" varchar(6) NOT NULL,
	"default_tax_rate_id" varchar(30),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(100) NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"type" varchar(10) NOT NULL,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"btw_rubriek" varchar(10),
	"description" text,
	"ledger_account_id" varchar(30),
	"reverse_charge" boolean DEFAULT false,
	"eu_service" boolean DEFAULT false,
	"export_goods" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"invoice_id" varchar(30) NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 4) DEFAULT '1',
	"unit_price" numeric(18, 4) NOT NULL,
	"unit" varchar(20),
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"tax_rate_id" varchar(30),
	"tax_rate" numeric(5, 2),
	"tax_amount" numeric(18, 2),
	"line_total" numeric(18, 2),
	"line_total_with_tax" numeric(18, 2),
	"account_id" varchar(30),
	"product_id" varchar(30),
	"period" jsonb,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"invoice_number" varchar(50),
	"type" varchar(15) DEFAULT 'standard' NOT NULL,
	"status" varchar(15) DEFAULT 'draft' NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"issue_date" timestamp NOT NULL,
	"due_date" timestamp NOT NULL,
	"paid_at" timestamp,
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"currency" varchar(3) DEFAULT 'EUR',
	"exchange_rate" numeric(12, 6) DEFAULT '1',
	"subtotal" numeric(18, 2) DEFAULT '0',
	"discount_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) DEFAULT '0',
	"amount_paid" numeric(18, 2) DEFAULT '0',
	"balance_due" numeric(18, 2) DEFAULT '0',
	"payment_terms_days" integer,
	"reference" varchar(255),
	"notes" text,
	"internal_notes" text,
	"billing_address" jsonb,
	"revenue_account_id" varchar(30),
	"credit_note_for_invoice_id" varchar(30),
	"original_invoice_id" varchar(30),
	"recurring_invoice_id" varchar(30),
	"commerce_order_id" varchar(30),
	"attachment_keys" jsonb,
	"email_history" jsonb,
	"tax_breakdown" jsonb,
	"payment_link" varchar(500),
	"journal_entry_id" varchar(30),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "bill_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"bill_id" varchar(30) NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 4) DEFAULT '1',
	"unit_price" numeric(18, 4) NOT NULL,
	"unit" varchar(20),
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"tax_rate_id" varchar(30),
	"tax_rate" numeric(5, 2),
	"tax_amount" numeric(18, 2),
	"line_total" numeric(18, 2),
	"line_total_with_tax" numeric(18, 2),
	"account_id" varchar(30),
	"product_id" varchar(30),
	"period" jsonb,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"bill_number" varchar(50),
	"type" varchar(15) DEFAULT 'standard' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	"contact_name" varchar(255),
	"issue_date" timestamp NOT NULL,
	"due_date" timestamp NOT NULL,
	"paid_at" timestamp,
	"currency" varchar(3) DEFAULT 'EUR',
	"exchange_rate" numeric(12, 6) DEFAULT '1',
	"subtotal" numeric(18, 2) DEFAULT '0',
	"discount_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) DEFAULT '0',
	"amount_paid" numeric(18, 2) DEFAULT '0',
	"balance_due" numeric(18, 2) DEFAULT '0',
	"payment_terms_days" integer,
	"external_reference" varchar(255),
	"reference" varchar(255),
	"notes" text,
	"internal_notes" text,
	"expense_account_id" varchar(30),
	"source_document_id" varchar(30),
	"approval_status" varchar(15) DEFAULT 'pending',
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"rejected_by" varchar(255),
	"rejected_at" timestamp,
	"rejection_reason" text,
	"attachment_keys" jsonb,
	"tax_breakdown" jsonb,
	"journal_entry_id" varchar(30),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entry_number" varchar(50),
	"date" timestamp NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"description" text,
	"reference" varchar(255),
	"total_debit" numeric(18, 2) DEFAULT '0',
	"total_credit" numeric(18, 2) DEFAULT '0',
	"source_type" varchar(30),
	"source_id" varchar(30),
	"reversal_of_id" varchar(30),
	"reversed_by_id" varchar(30),
	"fiscal_period_id" varchar(30),
	"attachment_keys" jsonb,
	"is_automatic" boolean DEFAULT false,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"journal_entry_id" varchar(30) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"description" text,
	"debit" numeric(18, 2) DEFAULT '0',
	"credit" numeric(18, 2) DEFAULT '0',
	"tax_rate_id" varchar(30),
	"tax_amount" numeric(18, 2),
	"contact_id" varchar(30),
	"currency" varchar(3) DEFAULT 'EUR',
	"exchange_rate" numeric(12, 6) DEFAULT '1',
	"base_currency_debit" numeric(18, 2),
	"base_currency_credit" numeric(18, 2),
	"reconciled" boolean DEFAULT false,
	"sort_order" integer
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"iban" varchar(34),
	"bic" varchar(11),
	"bank_name" varchar(255),
	"account_holder_name" varchar(255),
	"currency" varchar(3) DEFAULT 'EUR',
	"ledger_account_id" varchar(30),
	"current_balance" numeric(18, 2) DEFAULT '0',
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"last_import_date" timestamp,
	"last_import_balance" numeric(18, 2),
	"auto_reconcile" boolean DEFAULT true,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"bank_account_id" varchar(30) NOT NULL,
	"date" timestamp NOT NULL,
	"value_date" timestamp,
	"description" text,
	"amount" numeric(18, 2) NOT NULL,
	"running_balance" numeric(18, 2),
	"counterparty_name" varchar(255),
	"counterparty_iban" varchar(34),
	"counterparty_bic" varchar(11),
	"reference" varchar(255),
	"transaction_code" varchar(20),
	"end_to_end_id" varchar(255),
	"mandate_id" varchar(255),
	"import_batch_id" varchar(30),
	"external_id" varchar(255),
	"status" varchar(15) DEFAULT 'unreconciled' NOT NULL,
	"reconciliation_type" varchar(15),
	"reconciled_invoice_id" varchar(30),
	"reconciled_bill_id" varchar(30),
	"reconciled_payment_id" varchar(30),
	"journal_entry_id" varchar(30),
	"category_account_id" varchar(30),
	"tax_rate_id" varchar(30),
	"contact_id" varchar(30),
	"notes" text,
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"bank_account_id" varchar(30) NOT NULL,
	"file_name" varchar(255),
	"file_key" varchar(500),
	"format" varchar(10),
	"total_transactions" integer,
	"imported_count" integer,
	"duplicate_count" integer,
	"auto_reconciled_count" integer,
	"status" varchar(15) DEFAULT 'processing' NOT NULL,
	"date_range" jsonb,
	"opening_balance" numeric(18, 2),
	"closing_balance" numeric(18, 2),
	"errors" jsonb,
	"imported_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"priority" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"match_mode" varchar(5) DEFAULT 'all',
	"conditions" jsonb,
	"actions" jsonb,
	"match_count" integer DEFAULT 0,
	"last_matched_at" timestamp,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "vat_returns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"period_type" varchar(10) NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"period_label" varchar(50),
	"status" varchar(15) DEFAULT 'draft' NOT NULL,
	"rubrieken" jsonb,
	"supporting_data" jsonb,
	"xml_content" text,
	"filing_reference" varchar(255),
	"digipoort_response" jsonb,
	"filed_at" timestamp,
	"filed_by" varchar(255),
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"correction_of_id" varchar(30),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(20) DEFAULT 'purchase_invoice' NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"original_file_name" varchar(255),
	"file_key" varchar(500) NOT NULL,
	"file_size" integer,
	"mime_type" varchar(100),
	"thumbnail_key" varchar(500),
	"page_count" integer,
	"source" varchar(10) DEFAULT 'upload' NOT NULL,
	"status" varchar(15) DEFAULT 'pending' NOT NULL,
	"ocr_result" jsonb,
	"ocr_processed_at" timestamp,
	"ocr_model" varchar(50),
	"matched_contact_id" varchar(30),
	"linked_entity_type" varchar(20),
	"linked_entity_id" varchar(30),
	"email_message_id" varchar(30),
	"email_from" varchar(255),
	"email_subject" varchar(500),
	"notes" text,
	"tags" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255),
	"contact_id" varchar(30) NOT NULL,
	"frequency" varchar(15) NOT NULL,
	"day_of_month" integer,
	"next_issue_date" timestamp NOT NULL,
	"end_date" timestamp,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"template_data" jsonb,
	"auto_send" boolean DEFAULT false,
	"auto_finalize" boolean DEFAULT true,
	"generated_count" integer DEFAULT 0,
	"last_generated_at" timestamp,
	"last_generated_invoice_id" varchar(30),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(10) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"exchange_rate" numeric(12, 6) DEFAULT '1',
	"date" timestamp NOT NULL,
	"payment_method" varchar(20),
	"reference" varchar(255),
	"invoice_id" varchar(30),
	"bill_id" varchar(30),
	"contact_id" varchar(30) NOT NULL,
	"bank_account_id" varchar(30),
	"bank_transaction_id" varchar(30),
	"journal_entry_id" varchar(30),
	"exchange_difference_entry_id" varchar(30),
	"notes" text,
	"is_partial" boolean DEFAULT false,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"action" varchar(20) NOT NULL,
	"changes" jsonb,
	"user_id" varchar(255),
	"user_email" varchar(255),
	"ip_address" varchar(45),
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "iban" varchar(34);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "bic" varchar(11);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_revenue_account_id" varchar(30);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_expense_account_id" varchar(30);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "outstanding_balance" numeric(18, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "sepa_mandate" jsonb;--> statement-breakpoint
CREATE INDEX "acct_fiscal_periods_start_date_idx" ON "fiscal_periods" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "acct_fiscal_periods_end_date_idx" ON "fiscal_periods" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "acct_fiscal_periods_status_idx" ON "fiscal_periods" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_accounts_code_idx" ON "accounts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "acct_accounts_type_idx" ON "accounts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_accounts_parent_idx" ON "accounts" USING btree ("parent_account_id");--> statement-breakpoint
CREATE INDEX "acct_accounts_is_active_idx" ON "accounts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_type_idx" ON "tax_rates" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_is_active_idx" ON "tax_rates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_btw_rubriek_idx" ON "tax_rates" USING btree ("btw_rubriek");--> statement-breakpoint
CREATE INDEX "acct_invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "acct_invoices_number_idx" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "acct_invoices_contact_idx" ON "invoices" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_invoices_issue_date_idx" ON "invoices" USING btree ("issue_date");--> statement-breakpoint
CREATE INDEX "acct_invoices_due_date_idx" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "acct_invoices_type_idx" ON "invoices" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_bill_items_bill_idx" ON "bill_items" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "acct_bills_number_idx" ON "bills" USING btree ("bill_number");--> statement-breakpoint
CREATE INDEX "acct_bills_contact_idx" ON "bills" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_bills_status_idx" ON "bills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_bills_issue_date_idx" ON "bills" USING btree ("issue_date");--> statement-breakpoint
CREATE INDEX "acct_bills_due_date_idx" ON "bills" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "acct_bills_type_idx" ON "bills" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_number_idx" ON "journal_entries" USING btree ("entry_number");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_date_idx" ON "journal_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_status_idx" ON "journal_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_source_type_idx" ON "journal_entries" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_source_id_idx" ON "journal_entries" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_fiscal_period_idx" ON "journal_entries" USING btree ("fiscal_period_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_contact_idx" ON "journal_lines" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_bank_accounts_iban_idx" ON "bank_accounts" USING btree ("iban");--> statement-breakpoint
CREATE INDEX "acct_bank_accounts_is_active_idx" ON "bank_accounts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_bank_account_idx" ON "bank_transactions" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_date_idx" ON "bank_transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_status_idx" ON "bank_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_external_id_idx" ON "bank_transactions" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_counterparty_iban_idx" ON "bank_transactions" USING btree ("counterparty_iban");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_import_batch_idx" ON "bank_transactions" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_reconciled_invoice_idx" ON "bank_transactions" USING btree ("reconciled_invoice_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_reconciled_bill_idx" ON "bank_transactions" USING btree ("reconciled_bill_id");--> statement-breakpoint
CREATE INDEX "acct_bank_import_bank_account_idx" ON "bank_import_batches" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "acct_bank_import_status_idx" ON "bank_import_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_recon_rules_is_active_idx" ON "reconciliation_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "acct_recon_rules_priority_idx" ON "reconciliation_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "acct_vat_returns_period_start_idx" ON "vat_returns" USING btree ("period_start");--> statement-breakpoint
CREATE INDEX "acct_vat_returns_period_end_idx" ON "vat_returns" USING btree ("period_end");--> statement-breakpoint
CREATE INDEX "acct_vat_returns_status_idx" ON "vat_returns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_vat_returns_period_type_idx" ON "vat_returns" USING btree ("period_type");--> statement-breakpoint
CREATE INDEX "acct_documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_documents_type_idx" ON "documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_documents_source_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "acct_documents_linked_entity_idx" ON "documents" USING btree ("linked_entity_type","linked_entity_id");--> statement-breakpoint
CREATE INDEX "acct_documents_matched_contact_idx" ON "documents" USING btree ("matched_contact_id");--> statement-breakpoint
CREATE INDEX "acct_recurring_invoices_status_idx" ON "recurring_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_recurring_invoices_next_issue_idx" ON "recurring_invoices" USING btree ("next_issue_date");--> statement-breakpoint
CREATE INDEX "acct_recurring_invoices_contact_idx" ON "recurring_invoices" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_payments_type_idx" ON "payments" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "acct_payments_bill_idx" ON "payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "acct_payments_contact_idx" ON "payments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_payments_bank_txn_idx" ON "payments" USING btree ("bank_transaction_id");--> statement-breakpoint
CREATE INDEX "acct_payments_date_idx" ON "payments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "acct_audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "acct_audit_log_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "acct_audit_log_timestamp_idx" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "acct_audit_log_action_idx" ON "audit_log" USING btree ("action");