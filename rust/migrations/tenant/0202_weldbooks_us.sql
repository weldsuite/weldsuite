CREATE TABLE "sales_tax_agencies" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"state_code" varchar(2) NOT NULL,
	"level" varchar(10) DEFAULT 'state' NOT NULL,
	"local_jurisdiction_code" varchar(30),
	"name" varchar(255) NOT NULL,
	"registration_number" varchar(100),
	"registered_from" date,
	"registered_until" date,
	"status" varchar(15) DEFAULT 'registered' NOT NULL,
	"filing_frequency" varchar(15) DEFAULT 'quarterly' NOT NULL,
	"first_period_start" date,
	"due_day" integer DEFAULT 20 NOT NULL,
	"reporting_basis" varchar(10) DEFAULT 'accrual' NOT NULL,
	"sst_member" boolean DEFAULT false NOT NULL,
	"liability_account_id" varchar(30),
	"use_tax_account_id" varchar(30),
	"portal_url" varchar(500),
	"provider_registration_ref" varchar(255),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_tax_jurisdiction_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"jurisdiction_id" varchar(30) NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date
);
--> statement-breakpoint
CREATE TABLE "sales_tax_jurisdictions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"agency_id" varchar(30) NOT NULL,
	"state_code" varchar(2) NOT NULL,
	"level" varchar(10) NOT NULL,
	"code" varchar(30),
	"name" varchar(255) NOT NULL,
	"reporting_code" varchar(30),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_tax_taxability_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"agency_id" varchar(30) NOT NULL,
	"tax_code" varchar(30) NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"taxable_percent" numeric(7, 4) DEFAULT '100' NOT NULL,
	"applies_to_use" varchar(10) DEFAULT 'any' NOT NULL,
	"rate_override" numeric(7, 4),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_tax_zones" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"agency_id" varchar(30) NOT NULL,
	"state_code" varchar(2) NOT NULL,
	"name" varchar(255) NOT NULL,
	"jurisdiction_ids" jsonb NOT NULL,
	"postal_codes" jsonb,
	"is_origin" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_returns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"jurisdiction_code" varchar(5) NOT NULL,
	"agency_id" varchar(30),
	"state_code" varchar(10),
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date,
	"status" varchar(15) DEFAULT 'open' NOT NULL,
	"reporting_basis" varchar(10) DEFAULT 'accrual' NOT NULL,
	"summary" jsonb,
	"lines" jsonb,
	"adjustments" jsonb,
	"exceptions" jsonb,
	"total_due" numeric(18, 2) DEFAULT '0',
	"filed_at" timestamp,
	"filed_by" varchar(255),
	"confirmation_number" varchar(255),
	"paid_at" timestamp,
	"payment_amount" numeric(18, 2),
	"payment_bank_account_id" varchar(30),
	"payment_journal_entry_id" varchar(30),
	"amends_return_id" varchar(30),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "exemption_certificates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"party_id" varchar(30) NOT NULL,
	"states" jsonb NOT NULL,
	"reason" varchar(20) NOT NULL,
	"certificate_number" varchar(100),
	"form" varchar(20) DEFAULT 'state_form' NOT NULL,
	"issued_on" date,
	"expires_on" date,
	"blanket" boolean DEFAULT true NOT NULL,
	"invoice_id" varchar(30),
	"document_id" varchar(30),
	"status" varchar(15) DEFAULT 'valid' NOT NULL,
	"received_on" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"provider_connection_id" varchar(255) NOT NULL,
	"institution_id" varchar(100),
	"institution_name" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"credentials_encrypted" text,
	"sync_cursor" jsonb,
	"last_synced_at" timestamp,
	"last_error" text,
	"consent_expires_at" timestamp,
	"history_days" integer,
	"created_by" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "bank_feed_pending_transactions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"bank_account_id" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"provider_transaction_id" varchar(255) NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"description" text,
	"merchant_name" varchar(255),
	"voided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "bank_deposits" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"bank_account_id" varchar(30) NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"memo" text,
	"other_lines" jsonb,
	"status" varchar(10) DEFAULT 'posted' NOT NULL,
	"journal_entry_id" varchar(30),
	"bank_transaction_id" varchar(30),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"bank_account_id" varchar(30) NOT NULL,
	"ledger_account_id" varchar(30) NOT NULL,
	"statement_date" date NOT NULL,
	"beginning_balance" numeric(18, 2) NOT NULL,
	"statement_ending_balance" numeric(18, 2) NOT NULL,
	"cleared_balance" numeric(18, 2),
	"difference" numeric(18, 2),
	"status" varchar(15) DEFAULT 'in_progress' NOT NULL,
	"cleared_line_ids" jsonb,
	"report" jsonb,
	"adjustment_journal_entry_id" varchar(30),
	"completed_at" timestamp,
	"completed_by" varchar(255),
	"undone_at" timestamp,
	"undone_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "form_1099_filing_lines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"filing_id" varchar(30) NOT NULL,
	"party_id" varchar(30) NOT NULL,
	"recipient" jsonb,
	"recipient_tin_encrypted" text,
	"boxes" jsonb NOT NULL,
	"adjustments" jsonb,
	"federal_withheld" numeric(18, 2) DEFAULT '0',
	"state_code" varchar(2),
	"state_id_number" varchar(50),
	"state_income" numeric(18, 2),
	"state_withheld" numeric(18, 2),
	"status" varchar(15) DEFAULT 'included' NOT NULL,
	"excluded_reason" varchar(255),
	"is_corrected" boolean DEFAULT false NOT NULL,
	"correction_of_line_id" varchar(30),
	"delivery_method" varchar(10),
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "form_1099_filings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"tax_year" integer NOT NULL,
	"form_type" varchar(10) NOT NULL,
	"status" varchar(15) DEFAULT 'draft' NOT NULL,
	"generated_at" timestamp,
	"filed_at" timestamp,
	"confirmation_number" varchar(255),
	"notes" text,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "tax_id_reveals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30),
	"subject_type" varchar(20) NOT NULL,
	"subject_id" varchar(30) NOT NULL,
	"field" varchar(30) NOT NULL,
	"revealed_by" varchar(255) NOT NULL,
	"reason" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"bank_account_id" varchar(30) NOT NULL,
	"method" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"payment_date" date NOT NULL,
	"sec_code" varchar(5),
	"same_day" boolean DEFAULT false NOT NULL,
	"total_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"required_approvals" integer DEFAULT 2 NOT NULL,
	"approvals" jsonb,
	"items" jsonb,
	"holds" jsonb,
	"file_name" varchar(255),
	"file_generated_at" timestamp,
	"created_by" varchar(255),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "w9_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"party_id" varchar(30) NOT NULL,
	"email" varchar(255),
	"token_hash" varchar(64) NOT NULL,
	"status" varchar(15) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"requested_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_books" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"asset_id" varchar(30) NOT NULL,
	"book" varchar(10) NOT NULL,
	"state_code" varchar(2),
	"method" varchar(20) NOT NULL,
	"convention" varchar(15) DEFAULT 'full_month' NOT NULL,
	"recovery_years" numeric(5, 1) NOT NULL,
	"section_179_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"bonus_percent" numeric(7, 4) DEFAULT '0' NOT NULL,
	"depreciable_basis" numeric(18, 2) NOT NULL,
	"posts_to_ledger" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciation" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"asset_id" varchar(30) NOT NULL,
	"book_id" varchar(30) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"accumulated" numeric(18, 2) NOT NULL,
	"journal_entry_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"asset_number" varchar(50),
	"name" varchar(255) NOT NULL,
	"description" text,
	"asset_class" varchar(20),
	"asset_account_id" varchar(30) NOT NULL,
	"accumulated_depreciation_account_id" varchar(30) NOT NULL,
	"depreciation_expense_account_id" varchar(30) NOT NULL,
	"acquisition_date" date NOT NULL,
	"placed_in_service_date" date NOT NULL,
	"cost" numeric(18, 2) NOT NULL,
	"salvage_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"business_use_percent" numeric(7, 4) DEFAULT '100' NOT NULL,
	"bill_id" varchar(30),
	"bill_item_id" varchar(30),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"disposal_date" date,
	"disposal_proceeds" numeric(18, 2),
	"disposal_journal_entry_id" varchar(30),
	"class_id" varchar(30),
	"location_id" varchar(30),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "accounting_dimension_values" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"dimension" varchar(10) NOT NULL,
	"code" varchar(30),
	"name" varchar(255) NOT NULL,
	"parent_id" varchar(30),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_company_id" varchar(100),
	"credentials_encrypted" text,
	"account_mapping" jsonb,
	"status" varchar(15) DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "payroll_imports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"source" varchar(10) NOT NULL,
	"connection_id" varchar(30),
	"external_id" varchar(100),
	"period_start" date,
	"period_end" date,
	"pay_date" date NOT NULL,
	"summary" jsonb,
	"status" varchar(10) DEFAULT 'posted' NOT NULL,
	"journal_entry_id" varchar(30),
	"source_file_name" varchar(255),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "tax_calendar_completions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"deadline_key" varchar(120) NOT NULL,
	"due_date" date NOT NULL,
	"completed_by" varchar(255),
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tax_use" varchar(10);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "is_1099_vendor" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "default_1099_form" varchar(10);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "default_1099_box" varchar(20);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tin_type" varchar(5);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tin_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "sensitive_encrypted" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "w9" jsonb;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "backup_withholding" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tin_match_status" varchar(20);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tin_matched_at" timestamp;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "form_1099_e_delivery_consent_at" timestamp;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "ach_routing_number" varchar(9);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "ach_account_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "ach_account_type" varchar(10);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "bank_details_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "bank_details_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "bank_details_verified_by" varchar(255);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "dba" varchar(255);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "tax_classification" varchar(20);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "accounting_method" varchar(10);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "sales_tax_engine" varchar(30);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "sales_tax_engine_config" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "sales_tax_credentials_encrypted" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "ssn_encrypted" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "ssn_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "fiscal_year_config" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tax_line" varchar(40);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "form_1099_box" varchar(20);--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "effective_from" date;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "effective_to" date;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_code" varchar(30);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_use" varchar(10);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_included" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_override_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_override_reason" varchar(255);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "class_id" varchar(30);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "location_id" varchar(30);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "ship_from_address" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_engine" varchar(30);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_engine_ref" varchar(255);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_calculated_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_committed_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_warnings" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "marketplace_facilitated" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "tax_code" varchar(30);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "accrue_use_tax" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "form_1099_box" varchar(20);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "class_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "location_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "delivery_address" jsonb;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "reconciliation_id" varchar(30);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "class_id" varchar(30);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "location_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "account_type" varchar(20);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "routing_number" varchar(9);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "account_number_encrypted" text;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "account_number_last4" varchar(4);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_connection_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_provider" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_account_id" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_account_fingerprint" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_sync_from" date;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "feed_status" varchar(20);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "next_check_number" integer;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "check_settings" jsonb;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "ach_settings" jsonb;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "positive_pay_format" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "import_settings" jsonb;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "source" varchar(10);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "feed_provider" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "provider_transaction_id" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "check_number" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "merchant_name" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "feed_category" jsonb;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "possible_duplicate_of_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "deposit_id" varchar(30);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "deposit_id" varchar(30);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_run_id" varchar(30);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "check_status" varchar(10);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "check_printed_at" timestamp;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "backup_withholding_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_through_payroll" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "agency_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "jurisdiction_name" varchar(255);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "reporting_code" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "gross_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "exempt_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "non_taxable_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "exempt_reason" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "certificate_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "ship_to_state" varchar(10);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "ship_to_postal_code" varchar(10);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "tax_code" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "marketplace_facilitated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "unrounded_tax_amount" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "engine" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_lines" ADD COLUMN "engine_ref" varchar(255);--> statement-breakpoint
CREATE INDEX "acct_st_agencies_entity_idx" ON "sales_tax_agencies" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_st_agencies_state_idx" ON "sales_tax_agencies" USING btree ("entity_id","state_code");--> statement-breakpoint
CREATE INDEX "acct_st_agencies_status_idx" ON "sales_tax_agencies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_st_rates_jurisdiction_idx" ON "sales_tax_jurisdiction_rates" USING btree ("jurisdiction_id","effective_from");--> statement-breakpoint
CREATE INDEX "acct_st_jurisdictions_entity_idx" ON "sales_tax_jurisdictions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_st_jurisdictions_agency_idx" ON "sales_tax_jurisdictions" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "acct_st_taxability_agency_idx" ON "sales_tax_taxability_rules" USING btree ("agency_id","tax_code");--> statement-breakpoint
CREATE INDEX "acct_st_zones_entity_idx" ON "sales_tax_zones" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_st_zones_agency_idx" ON "sales_tax_zones" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "acct_tax_returns_entity_idx" ON "tax_returns" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_tax_returns_agency_period_idx" ON "tax_returns" USING btree ("agency_id","period_start");--> statement-breakpoint
CREATE INDEX "acct_tax_returns_status_idx" ON "tax_returns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_exemption_certs_entity_idx" ON "exemption_certificates" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_exemption_certs_party_idx" ON "exemption_certificates" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "acct_exemption_certs_status_idx" ON "exemption_certificates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_bank_connections_entity_idx" ON "bank_connections" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_bank_connections_provider_uidx" ON "bank_connections" USING btree ("provider","provider_connection_id");--> statement-breakpoint
CREATE INDEX "acct_bank_feed_pending_account_idx" ON "bank_feed_pending_transactions" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_bank_feed_pending_provider_uidx" ON "bank_feed_pending_transactions" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "acct_bank_deposits_entity_idx" ON "bank_deposits" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bank_deposits_bank_account_idx" ON "bank_deposits" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "acct_bank_deposits_date_idx" ON "bank_deposits" USING btree ("date");--> statement-breakpoint
CREATE INDEX "acct_bank_recs_entity_idx" ON "bank_reconciliations" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bank_recs_bank_account_idx" ON "bank_reconciliations" USING btree ("bank_account_id","statement_date");--> statement-breakpoint
CREATE INDEX "acct_1099_lines_filing_idx" ON "form_1099_filing_lines" USING btree ("filing_id");--> statement-breakpoint
CREATE INDEX "acct_1099_lines_party_idx" ON "form_1099_filing_lines" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "acct_1099_filings_entity_year_idx" ON "form_1099_filings" USING btree ("entity_id","tax_year");--> statement-breakpoint
CREATE INDEX "acct_tax_id_reveals_subject_idx" ON "tax_id_reveals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "acct_tax_id_reveals_created_idx" ON "tax_id_reveals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "acct_payment_runs_entity_idx" ON "payment_runs" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_payment_runs_status_idx" ON "payment_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_w9_requests_party_idx" ON "w9_requests" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "acct_w9_requests_token_idx" ON "w9_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "acct_fixed_asset_books_asset_idx" ON "fixed_asset_books" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "acct_fixed_asset_dep_asset_idx" ON "fixed_asset_depreciation" USING btree ("asset_id","period_start");--> statement-breakpoint
CREATE INDEX "acct_fixed_asset_dep_book_idx" ON "fixed_asset_depreciation" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "acct_fixed_assets_entity_idx" ON "fixed_assets" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_fixed_assets_status_idx" ON "fixed_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_dimension_values_entity_idx" ON "accounting_dimension_values" USING btree ("entity_id","dimension");--> statement-breakpoint
CREATE INDEX "acct_payroll_connections_entity_idx" ON "payroll_connections" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_payroll_imports_entity_idx" ON "payroll_imports" USING btree ("entity_id","pay_date");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_payroll_imports_external_uidx" ON "payroll_imports" USING btree ("entity_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_tax_calendar_completions_uidx" ON "tax_calendar_completions" USING btree ("entity_id","deadline_key");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_reconciliation_idx" ON "journal_lines" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "acct_bank_accounts_feed_connection_idx" ON "bank_accounts" USING btree ("feed_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_bank_txn_provider_uidx" ON "bank_transactions" USING btree ("bank_account_id","feed_provider","provider_transaction_id") WHERE "bank_transactions"."provider_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "acct_bank_txn_fingerprint_idx" ON "bank_transactions" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "acct_payments_deposit_idx" ON "payments" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "acct_payments_run_idx" ON "payments" USING btree ("payment_run_id");--> statement-breakpoint
CREATE INDEX "acct_tax_lines_agency_date_idx" ON "tax_lines" USING btree ("agency_id","tax_date");