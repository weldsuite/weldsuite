CREATE TABLE "commerce_connection_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"provider" varchar(30) DEFAULT 'mollie' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "storefront_key_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"kind" varchar(12) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotated_from_id" varchar(30),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "commerce_connection_registry_workspace_idx" ON "commerce_connection_registry" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_key_registry_hash_idx" ON "storefront_key_registry" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "storefront_key_registry_workspace_channel_idx" ON "storefront_key_registry" USING btree ("workspace_id","channel_id");