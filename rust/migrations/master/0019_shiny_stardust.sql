CREATE TABLE "ai_model_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"model_id" varchar(100) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"tier" varchar(20) DEFAULT 'standard' NOT NULL,
	"input_price_cents" integer NOT NULL,
	"output_price_cents" integer NOT NULL,
	"credits_per_k_token" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "tax_amount" integer;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "subtotal_amount" integer;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "customer_country" varchar(2);--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "customer_tax_exempt" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_rates_model_id_idx" ON "ai_model_rates" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "ai_model_rates_provider_idx" ON "ai_model_rates" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "ai_model_rates_is_active_idx" ON "ai_model_rates" USING btree ("is_active");