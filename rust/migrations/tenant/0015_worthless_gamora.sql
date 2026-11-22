CREATE TYPE "public"."credit_service_type" AS ENUM('ai_tokens', 'parcel_label', 'meeting_bot', 'sms', 'voip_call');--> statement-breakpoint
CREATE TYPE "public"."credit_transaction_type" AS ENUM('monthly_allocation', 'rollover', 'purchase', 'consumption', 'refund', 'expiry', 'adjustment');--> statement-breakpoint
CREATE TABLE "workspace_credits" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"current_balance" integer DEFAULT 0 NOT NULL,
	"monthly_allocation" integer DEFAULT 0 NOT NULL,
	"rolled_over_credits" integer DEFAULT 0 NOT NULL,
	"rollover_cap" integer,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"last_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_credits_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "credit_packages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"credits" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"stripe_price_id" varchar(255),
	"stripe_product_id" varchar(255),
	"is_popular" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"type" varchar(30) NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"service_type" varchar(30),
	"reference_id" varchar(30),
	"reference_type" varchar(50),
	"stripe_payment_intent_id" varchar(255),
	"stripe_checkout_session_id" varchar(255),
	"amount_paid" numeric(10, 2),
	"currency" varchar(3),
	"description" text,
	"metadata" jsonb,
	"user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_credits_workspace_idx" ON "workspace_credits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_credits_period_end_idx" ON "workspace_credits" USING btree ("period_end");--> statement-breakpoint
CREATE INDEX "credit_packages_active_idx" ON "credit_packages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "credit_packages_sort_idx" ON "credit_packages" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "credit_transactions_workspace_idx" ON "credit_transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_type_idx" ON "credit_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "credit_transactions_service_type_idx" ON "credit_transactions" USING btree ("service_type");--> statement-breakpoint
CREATE INDEX "credit_transactions_reference_idx" ON "credit_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_created_at_idx" ON "credit_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_stripe_payment_idx" ON "credit_transactions" USING btree ("stripe_payment_intent_id");