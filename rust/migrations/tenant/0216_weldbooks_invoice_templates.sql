CREATE TABLE "invoice_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"paper_size" varchar(10) DEFAULT 'a4' NOT NULL,
	"document" jsonb NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "template_id" varchar(30);--> statement-breakpoint
CREATE INDEX "acct_invoice_templates_entity_idx" ON "invoice_templates" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_invoice_templates_one_default_idx" ON "invoice_templates" USING btree ("entity_id") WHERE "invoice_templates"."is_default";