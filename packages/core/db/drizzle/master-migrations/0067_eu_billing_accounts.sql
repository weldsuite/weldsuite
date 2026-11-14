CREATE TABLE "billing_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"provider" varchar(20) DEFAULT 'mollie' NOT NULL,
	"customer_id" varchar(255),
	"mandate_id" varchar(255),
	"mandate_method" varchar(30),
	"mandate_label" varchar(100),
	"unit_amount" integer,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"anchor_day" smallint,
	"next_charge_at" timestamp,
	"scheduled_plan_id" varchar(30),
	"scheduled_seats" integer,
	"scheduled_cycle" varchar(10),
	"past_due_since" timestamp,
	"past_due_payment_id" varchar(30),
	"dunning_reminded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "stripe_invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "provider" varchar(20) DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "provider_invoice_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "provider_payment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "lines" jsonb;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "document_key" text;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "provider" varchar(20) DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "provider_payment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "kind" varchar(30);--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_accounts_next_charge_at_idx" ON "billing_accounts" USING btree ("next_charge_at");--> statement-breakpoint
CREATE INDEX "billing_accounts_past_due_since_idx" ON "billing_accounts" USING btree ("past_due_since");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer_id_idx" ON "billing_accounts" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_provider_payment_id_unique" UNIQUE("provider_payment_id");--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_provider_payment_id_unique" UNIQUE("provider_payment_id");--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_idempotency_key_unique" UNIQUE("idempotency_key");