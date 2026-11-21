CREATE TABLE "workspace_sso" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"domain" varchar(253),
	"domain_verification_token" varchar(64),
	"domain_verified_at" timestamp with time zone,
	"clerk_connection_id" varchar(64),
	"provider" varchar(30),
	"enabled" boolean DEFAULT false NOT NULL,
	"clerk_active" boolean DEFAULT false NOT NULL,
	"acs_url" text,
	"sp_entity_id" text,
	"sp_metadata_url" text,
	"connection_updated_by" varchar(255),
	"connection_updated_at" timestamp with time zone,
	"price_override_cents" integer,
	"price_override_currency" varchar(3),
	"price_override_set_by" varchar(255),
	"price_override_set_at" timestamp with time zone,
	"price_override_reason" text,
	"stripe_subscription_id" varchar(255),
	"subscription_status" varchar(20) DEFAULT 'none' NOT NULL,
	"subscription_status_at" timestamp with time zone,
	"subscription_current_period_end" timestamp with time zone,
	"subscription_cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sso_workspace_idx" ON "workspace_sso" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sso_verified_domain_idx" ON "workspace_sso" USING btree ("domain") WHERE "workspace_sso"."domain_verified_at" is not null;--> statement-breakpoint
CREATE INDEX "workspace_sso_clerk_org_idx" ON "workspace_sso" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE INDEX "workspace_sso_subscription_idx" ON "workspace_sso" USING btree ("stripe_subscription_id");