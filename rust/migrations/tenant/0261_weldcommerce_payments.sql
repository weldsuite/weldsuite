CREATE TABLE "commerce_payment_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider" varchar(30) DEFAULT 'mollie' NOT NULL,
	"auth_method" varchar(10) DEFAULT 'oauth' NOT NULL,
	"status" varchar(20) DEFAULT 'connected' NOT NULL,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"api_key_encrypted" text,
	"token_expires_at" timestamp,
	"scope" text,
	"profile_id" varchar(50),
	"profile_name" varchar(255),
	"organization_id" varchar(50),
	"organization_name" varchar(255),
	"testmode" boolean DEFAULT false NOT NULL,
	"connected_by" varchar(255),
	"connected_at" timestamp,
	"disconnected_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "commerce_payments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"connection_id" varchar(30),
	"provider" varchar(30) DEFAULT 'mollie' NOT NULL,
	"provider_payment_id" varchar(100),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"method" varchar(50),
	"checkout_url" text,
	"redirect_url" text,
	"testmode" boolean DEFAULT false NOT NULL,
	"amount_refunded" numeric(18, 2) DEFAULT '0' NOT NULL,
	"failure_reason" text,
	"provider_data" jsonb,
	"idempotency_key" varchar(100),
	"expires_at" timestamp,
	"paid_at" timestamp,
	"failed_at" timestamp,
	"canceled_at" timestamp,
	"expired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commerce_refunds" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"payment_id" varchar(30) NOT NULL,
	"provider" varchar(30) DEFAULT 'mollie' NOT NULL,
	"provider_refund_id" varchar(100),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" text,
	"credit_note_id" varchar(30),
	"created_by" varchar(255),
	"idempotency_key" varchar(100),
	"refunded_at" timestamp,
	"failed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "commerce_settings" ADD COLUMN "default_entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "commerce_settings" ADD COLUMN "auto_invoice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_connections_provider_uidx" ON "commerce_payment_connections" USING btree ("provider") WHERE "commerce_payment_connections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "commerce_payments_order_idx" ON "commerce_payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "commerce_payments_status_idx" ON "commerce_payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payments_provider_payment_uidx" ON "commerce_payments" USING btree ("provider","provider_payment_id") WHERE "commerce_payments"."provider_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payments_idempotency_key_uidx" ON "commerce_payments" USING btree ("idempotency_key") WHERE "commerce_payments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_refunds_order_idx" ON "commerce_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "commerce_refunds_payment_idx" ON "commerce_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_refunds_provider_refund_uidx" ON "commerce_refunds" USING btree ("provider","provider_refund_id") WHERE "commerce_refunds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_refunds_idempotency_key_uidx" ON "commerce_refunds" USING btree ("idempotency_key") WHERE "commerce_refunds"."idempotency_key" IS NOT NULL;