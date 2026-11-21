CREATE TABLE "tax_lines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" varchar(30),
	"source_line_id" varchar(30),
	"journal_entry_id" varchar(30) NOT NULL,
	"tax_date" date NOT NULL,
	"direction" varchar(10) NOT NULL,
	"tax_rate_id" varchar(30),
	"tax_rate_name" varchar(100),
	"tax_category_code" varchar(30),
	"rate" numeric(7, 4) NOT NULL,
	"component" varchar(20),
	"self_assessed" boolean DEFAULT false NOT NULL,
	"jurisdiction_code" varchar(30),
	"jurisdiction_level" varchar(20),
	"state_code" varchar(10),
	"taxable_amount" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"base_taxable_amount" numeric(18, 2) NOT NULL,
	"base_tax_amount" numeric(18, 2) NOT NULL,
	"contact_id" varchar(30),
	"tax_return_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"payment_id" varchar(30) NOT NULL,
	"invoice_id" varchar(30),
	"bill_id" varchar(30),
	"amount" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lock_date_exceptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"lock_type" varchar(10) NOT NULL,
	"user_id" varchar(255),
	"ends_at" timestamp NOT NULL,
	"reason" text NOT NULL,
	"created_by" varchar(255),
	"revoked_at" timestamp,
	"revoked_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "tax_rates" ALTER COLUMN "rate" SET DATA TYPE numeric(7, 4);--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "tax_rate" SET DATA TYPE numeric(7, 4);--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "tax_rate" SET DATA TYPE numeric(7, 4);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "sales_lock_date" date;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "purchase_lock_date" date;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "tax_lock_date" date;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "period_lock_date" date;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "hard_lock_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vendor_address" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "posting_key" varchar(100);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "check_number" varchar(30);--> statement-breakpoint
CREATE INDEX "acct_tax_lines_entity_date_idx" ON "tax_lines" USING btree ("entity_id","tax_date");--> statement-breakpoint
CREATE INDEX "acct_tax_lines_source_idx" ON "tax_lines" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "acct_tax_lines_journal_entry_idx" ON "tax_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "acct_tax_lines_tax_rate_idx" ON "tax_lines" USING btree ("tax_rate_id");--> statement-breakpoint
CREATE INDEX "acct_tax_lines_tax_return_idx" ON "tax_lines" USING btree ("tax_return_id");--> statement-breakpoint
CREATE INDEX "acct_payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "acct_payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "acct_payment_allocations_bill_idx" ON "payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "acct_lock_date_exceptions_entity_idx" ON "lock_date_exceptions" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_journal_entries_posting_key_uidx" ON "journal_entries" USING btree ("posting_key");