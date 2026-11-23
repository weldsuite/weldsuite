CREATE TABLE "billing_invoices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"stripe_invoice_id" varchar(255) NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"number" varchar(100),
	"amount_due" integer,
	"amount_paid" integer,
	"currency" varchar(10),
	"status" varchar(30),
	"billing_reason" varchar(50),
	"period_start" timestamp,
	"period_end" timestamp,
	"pdf_url" text,
	"hosted_url" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "billing_payments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"invoice_id" varchar(30),
	"stripe_payment_intent_id" varchar(255),
	"stripe_charge_id" varchar(255),
	"amount" integer NOT NULL,
	"currency" varchar(10) NOT NULL,
	"status" varchar(30) NOT NULL,
	"payment_method_type" varchar(30),
	"payment_method_brand" varchar(30),
	"payment_method_last4" varchar(4),
	"failure_code" varchar(100),
	"failure_message" text,
	"refunded_amount" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payments_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_status" varchar(30);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_cycle" varchar(10);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_current_period_start" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_invoices_workspace_id_idx" ON "billing_invoices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_stripe_customer_id_idx" ON "billing_invoices" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_status_idx" ON "billing_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_invoices_created_at_idx" ON "billing_invoices" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "billing_payments_workspace_id_idx" ON "billing_payments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "billing_payments_invoice_id_idx" ON "billing_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "billing_payments_status_idx" ON "billing_payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_payments_created_at_idx" ON "billing_payments" USING btree ("created_at");