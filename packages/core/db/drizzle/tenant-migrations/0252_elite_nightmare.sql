CREATE TABLE "ai_provider_keys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"ciphertext" text NOT NULL,
	"key_hint" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"providers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_provider" varchar(32),
	"feature_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(255),
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_keys_provider_idx" ON "ai_provider_keys" USING btree ("provider");