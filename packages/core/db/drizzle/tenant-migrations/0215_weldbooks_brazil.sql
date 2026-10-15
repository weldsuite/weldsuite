CREATE TABLE "fiscal_documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" varchar(30) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_ref" varchar(60) NOT NULL,
	"environment" varchar(12) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"status_message" text,
	"number" varchar(20),
	"series" varchar(5),
	"access_key" varchar(44),
	"verification_code" varchar(60),
	"protocol" varchar(60),
	"authorized_at" timestamp,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"xml_url" text,
	"pdf_url" text,
	"public_url" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "received_fiscal_documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"kind" varchar(10) DEFAULT 'nfe' NOT NULL,
	"access_key" varchar(44) NOT NULL,
	"issuer_tax_id" varchar(14),
	"issuer_name" varchar(255),
	"number" varchar(20),
	"series" varchar(5),
	"issue_date" date,
	"total" numeric(18, 2),
	"status" varchar(15) DEFAULT 'new' NOT NULL,
	"manifestation" varchar(20),
	"source" varchar(20) NOT NULL,
	"xml" text,
	"parsed" jsonb,
	"bill_id" varchar(30)
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "br_fiscal" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "fiscal_credentials_encrypted" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "ncm" varchar(8);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "cfop" varchar(4);--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "fiscal_data" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fiscal_data" jsonb;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "ncm" varchar(8);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "cfop" varchar(4);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "fiscal_data" jsonb;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "fiscal_data" jsonb;--> statement-breakpoint
CREATE INDEX "fiscal_documents_entity_idx" ON "fiscal_documents" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "fiscal_documents_source_idx" ON "fiscal_documents" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_documents_provider_ref_idx" ON "fiscal_documents" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "fiscal_documents_access_key_idx" ON "fiscal_documents" USING btree ("access_key");--> statement-breakpoint
CREATE UNIQUE INDEX "received_fiscal_documents_key_idx" ON "received_fiscal_documents" USING btree ("entity_id","access_key");--> statement-breakpoint
CREATE INDEX "received_fiscal_documents_status_idx" ON "received_fiscal_documents" USING btree ("entity_id","status");