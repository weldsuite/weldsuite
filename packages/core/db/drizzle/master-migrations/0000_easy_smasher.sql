CREATE TYPE "public"."feature_status" AS ENUM('open', 'under_review', 'planned', 'in_progress', 'completed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."feature_type" AS ENUM('feature', 'bug', 'improvement');--> statement-breakpoint
CREATE TYPE "public"."inquiry_status" AS ENUM('new', 'contacted', 'in_progress', 'closed', 'converted');--> statement-breakpoint
CREATE TYPE "public"."tenant_tier" AS ENUM('free', 'starter', 'professional', 'enterprise');--> statement-breakpoint
CREATE TABLE "app_catalog" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"icon" varchar(50) NOT NULL,
	"category" varchar(50) NOT NULL,
	"path" varchar(100) NOT NULL,
	"overview" text,
	"features" jsonb DEFAULT '[]'::jsonb,
	"how_it_works" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" varchar(20) DEFAULT '1.0.0',
	"provider" varchar(100) DEFAULT 'WeldSuite',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_catalog_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "app_screenshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"caption" varchar(255),
	"alt_text" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_inquiries" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"team_size" varchar(50) NOT NULL,
	"contact_name" varchar(255) NOT NULL,
	"contact_email" varchar(255) NOT NULL,
	"contact_phone" varchar(50),
	"use_case" text,
	"status" "inquiry_status" DEFAULT 'new' NOT NULL,
	"notes" text,
	"assigned_to" varchar(255),
	"source" varchar(100) DEFAULT 'pricing_dialog',
	"workspace_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contacted_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feature_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text NOT NULL,
	"type" "feature_type" DEFAULT 'feature' NOT NULL,
	"submitter_id" varchar(255) NOT NULL,
	"submitter_name" varchar(255) NOT NULL,
	"submitter_email" varchar(255) NOT NULL,
	"workspace_id" varchar(255),
	"status" "feature_status" DEFAULT 'open' NOT NULL,
	"admin_notes" text,
	"vote_count" integer DEFAULT 0 NOT NULL,
	"voters" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domain_pricing" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"tld" varchar(50) NOT NULL,
	"category" varchar(100),
	"registration_price" numeric(10, 2) NOT NULL,
	"renewal_price" numeric(10, 2) NOT NULL,
	"transfer_price" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"min_years" integer DEFAULT 1,
	"max_years" integer DEFAULT 10,
	"is_active" boolean DEFAULT true NOT NULL,
	"has_active_promotion" boolean DEFAULT false,
	"is_popular" boolean DEFAULT false,
	"is_premium" boolean DEFAULT false,
	"supports_privacy_protection" boolean DEFAULT true,
	"supports_auto_renew" boolean DEFAULT true,
	"supports_transfer" boolean DEFAULT true,
	"promotion_price" numeric(10, 2),
	"promotion_ends_at" timestamp,
	"registrar" varchar(100) DEFAULT 'realtimeregister',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domain_pricing_tld_unique" UNIQUE("tld")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"price_monthly" numeric(18, 2) DEFAULT '0' NOT NULL,
	"price_yearly" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb,
	"max_users" integer,
	"max_projects" integer,
	"max_storage" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"badge" varchar(50),
	"color" varchar(20),
	"stripe_product_id" varchar(255),
	"stripe_price_id_monthly" varchar(255),
	"stripe_price_id_yearly" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"category" varchar(50) DEFAULT 'general' NOT NULL,
	"value" jsonb,
	"description" text,
	"data_type" varchar(20) DEFAULT 'string',
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "widget_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"widget_id" varchar(50) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"widget_name" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "widget_registry_widget_id_unique" UNIQUE("widget_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"plan_id" varchar(30),
	"database_url" text,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "app_screenshots" ADD CONSTRAINT "app_screenshots_app_id_app_catalog_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_registry" ADD CONSTRAINT "widget_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_catalog_code_idx" ON "app_catalog" USING btree ("code");--> statement-breakpoint
CREATE INDEX "app_catalog_category_idx" ON "app_catalog" USING btree ("category");--> statement-breakpoint
CREATE INDEX "app_catalog_is_active_idx" ON "app_catalog" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "app_catalog_is_published_idx" ON "app_catalog" USING btree ("is_published");--> statement-breakpoint
CREATE INDEX "app_catalog_sort_order_idx" ON "app_catalog" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "app_screenshots_app_id_idx" ON "app_screenshots" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_screenshots_sort_order_idx" ON "app_screenshots" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "enterprise_inquiries_status_idx" ON "enterprise_inquiries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "enterprise_inquiries_email_idx" ON "enterprise_inquiries" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "enterprise_inquiries_created_idx" ON "enterprise_inquiries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feature_requests_status_idx" ON "feature_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feature_requests_type_idx" ON "feature_requests" USING btree ("type");--> statement-breakpoint
CREATE INDEX "feature_requests_vote_count_idx" ON "feature_requests" USING btree ("vote_count");--> statement-breakpoint
CREATE INDEX "feature_requests_created_at_idx" ON "feature_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feature_requests_submitter_idx" ON "feature_requests" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "domain_pricing_tld_idx" ON "domain_pricing" USING btree ("tld");--> statement-breakpoint
CREATE INDEX "domain_pricing_category_idx" ON "domain_pricing" USING btree ("category");--> statement-breakpoint
CREATE INDEX "domain_pricing_is_active_idx" ON "domain_pricing" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "domain_pricing_is_popular_idx" ON "domain_pricing" USING btree ("is_popular");--> statement-breakpoint
CREATE INDEX "plans_slug_idx" ON "plans" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "plans_is_active_idx" ON "plans" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "plans_sort_order_idx" ON "plans" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "system_settings_category_idx" ON "system_settings" USING btree ("category");--> statement-breakpoint
CREATE INDEX "widget_registry_widget_id_idx" ON "widget_registry" USING btree ("widget_id");--> statement-breakpoint
CREATE INDEX "widget_registry_workspace_id_idx" ON "widget_registry" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "widget_registry_is_active_idx" ON "widget_registry" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "workspaces_plan_id_idx" ON "workspaces" USING btree ("plan_id");