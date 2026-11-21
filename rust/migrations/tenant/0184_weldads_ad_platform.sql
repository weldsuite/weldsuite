CREATE TYPE "public"."ad_platform" AS ENUM('facebook', 'google');--> statement-breakpoint
CREATE TYPE "public"."ad_platform_connection_status" AS ENUM('active', 'error', 'pending_reauth');--> statement-breakpoint
CREATE TYPE "public"."ad_campaign_sync_status" AS ENUM('local', 'pending_push', 'synced', 'error');--> statement-breakpoint
CREATE TABLE "ad_platform_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"platform" "ad_platform" NOT NULL,
	"status" "ad_platform_connection_status" DEFAULT 'active' NOT NULL,
	"meta_user_id" varchar(255),
	"meta_user_name" varchar(255),
	"oauth_tokens" jsonb,
	"token_expires_at" timestamp,
	"last_sync_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"connection_id" varchar(30) NOT NULL,
	"platform_account_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"currency" varchar(10),
	"timezone" varchar(100),
	"status" varchar(50),
	"is_selected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"ad_account_id" varchar(30) NOT NULL,
	"platform_campaign_id" varchar(255),
	"name" varchar(255) NOT NULL,
	"status" varchar(50),
	"objective" varchar(100),
	"daily_budget" integer,
	"lifetime_budget" integer,
	"currency" varchar(10),
	"metrics" jsonb,
	"metrics_synced_at" timestamp,
	"content_hash" varchar(64),
	"sync_status" "ad_campaign_sync_status" DEFAULT 'local' NOT NULL,
	"sync_error" text,
	"last_synced_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_id_ad_platform_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ad_platform_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_platform_connections_platform_idx" ON "ad_platform_connections" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "ad_platform_connections_status_idx" ON "ad_platform_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_connection_platform_account_idx" ON "ad_accounts" USING btree ("connection_id","platform_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_connection_idx" ON "ad_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_is_selected_idx" ON "ad_accounts" USING btree ("is_selected");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_account_platform_campaign_idx" ON "ad_campaigns" USING btree ("ad_account_id","platform_campaign_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_ad_account_idx" ON "ad_campaigns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_campaigns_sync_status_idx" ON "ad_campaigns" USING btree ("sync_status");
