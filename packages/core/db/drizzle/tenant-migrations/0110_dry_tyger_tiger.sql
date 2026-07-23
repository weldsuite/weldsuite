CREATE TABLE "entities" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"legal_name" varchar(255),
	"entity_type" varchar(20),
	"jurisdiction_code" varchar(5) NOT NULL,
	"base_currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"locale" varchar(10) DEFAULT 'nl-NL' NOT NULL,
	"timezone" varchar(50) DEFAULT 'Europe/Amsterdam',
	"tax_identifiers" jsonb,
	"address" jsonb,
	"contact" jsonb,
	"bank_details" jsonb,
	"branding" jsonb,
	"jurisdiction_settings" jsonb,
	"fiscal_year_start" integer DEFAULT 1,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "entity_number_sequences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"sequence_type" varchar(20) NOT NULL,
	"prefix" varchar(20) DEFAULT '' NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"source" varchar(20) DEFAULT 'ecb' NOT NULL
);
--> statement-breakpoint
DROP INDEX "acct_tax_rates_btw_rubriek_idx";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "jurisdiction_code" varchar(5) NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "tax_category_code" varchar(30);--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "jurisdiction_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_rules" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "entity_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "accounting_entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "calendar_booking_pages" ADD COLUMN "timezone" varchar(100) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_bookings" ADD COLUMN "guests" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_bookings" ADD COLUMN "timezone" varchar(100);--> statement-breakpoint
CREATE INDEX "entities_jurisdiction_idx" ON "entities" USING btree ("jurisdiction_code");--> statement-breakpoint
CREATE INDEX "entities_is_default_idx" ON "entities" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "entities_is_active_idx" ON "entities" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_sequences_unique" ON "entity_number_sequences" USING btree ("entity_id","sequence_type");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_unique" ON "fx_rates" USING btree ("date","from_currency","to_currency","source");--> statement-breakpoint
CREATE INDEX "fx_rates_date_idx" ON "fx_rates" USING btree ("date");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_idx" ON "fx_rates" USING btree ("from_currency","to_currency");--> statement-breakpoint
CREATE INDEX "acct_fiscal_periods_entity_idx" ON "fiscal_periods" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_accounts_entity_idx" ON "accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_entity_idx" ON "tax_rates" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_jurisdiction_idx" ON "tax_rates" USING btree ("jurisdiction_code");--> statement-breakpoint
CREATE INDEX "acct_tax_rates_category_idx" ON "tax_rates" USING btree ("tax_category_code");--> statement-breakpoint
CREATE INDEX "acct_invoice_items_entity_idx" ON "invoice_items" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_invoices_entity_idx" ON "invoices" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bill_items_entity_idx" ON "bill_items" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bills_entity_idx" ON "bills" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_journal_entries_entity_idx" ON "journal_entries" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_entity_idx" ON "journal_lines" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bank_accounts_entity_idx" ON "bank_accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_entity_idx" ON "bank_transactions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_bank_import_entity_idx" ON "bank_import_batches" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_recon_rules_entity_idx" ON "reconciliation_rules" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_vat_returns_entity_idx" ON "vat_returns" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_documents_entity_idx" ON "documents" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_recurring_invoices_entity_idx" ON "recurring_invoices" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_payments_entity_idx" ON "payments" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_audit_log_accounting_entity_idx" ON "audit_log" USING btree ("accounting_entity_id");--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "default_currency";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "invoice_number_prefix";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "invoice_number_next";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "bill_number_prefix";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "bill_number_next";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "credit_note_number_prefix";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "credit_note_number_next";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "journal_number_prefix";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "journal_number_next";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "company_details";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "tax_settings";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "invoice_template_settings";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "digipoort_settings";--> statement-breakpoint
ALTER TABLE "tax_rates" DROP COLUMN "btw_rubriek";--> statement-breakpoint
ALTER TABLE "tax_rates" DROP COLUMN "reverse_charge";--> statement-breakpoint
ALTER TABLE "tax_rates" DROP COLUMN "eu_service";--> statement-breakpoint
ALTER TABLE "tax_rates" DROP COLUMN "export_goods";