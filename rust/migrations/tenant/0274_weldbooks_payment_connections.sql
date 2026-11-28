CREATE TABLE "accounting_payment_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
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
	"methods" jsonb,
	"bank_account_id" varchar(30),
	"connected_by" varchar(255),
	"connected_at" timestamp,
	"disconnected_at" timestamp,
	"last_error" text,
	"settlements_synced_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_payment_connections_entity_provider_uidx" ON "accounting_payment_connections" USING btree ("entity_id","provider") WHERE "accounting_payment_connections"."deleted_at" IS NULL;