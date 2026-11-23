CREATE TABLE "app_developer_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"stripe_connect_account_id" varchar(255),
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_developer_accounts_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "user_app_installs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb,
	"pending_scopes" jsonb,
	"installed_by" varchar(255) NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"stripe_subscription_id" varchar(255),
	"subscription_status" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_app_oauth_clients" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"client_secret_hash" varchar(255) NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_app_oauth_clients_app_id_unique" UNIQUE("app_id"),
	CONSTRAINT "user_app_oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "user_app_tokens" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"install_id" varchar(30) NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"token_prefix" varchar(20) NOT NULL,
	"token_type" varchar(20) DEFAULT 'install' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_app_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"version" varchar(20) NOT NULL,
	"manifest" jsonb,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb,
	"bundle_key" varchar(500) NOT NULL,
	"entrypoint" varchar(255) DEFAULT 'index.html' NOT NULL,
	"bundle_size" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"changelog" text,
	"created_by" varchar(255) NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_apps" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon" varchar(50) DEFAULT 'Puzzle' NOT NULL,
	"category" varchar(50) DEFAULT 'Productivity' NOT NULL,
	"owner_workspace_id" varchar(255) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"review_status" varchar(20) DEFAULT 'draft' NOT NULL,
	"review_notes" text,
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp with time zone,
	"current_version_id" varchar(30),
	"manifest" jsonb,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb,
	"pricing_type" varchar(20) DEFAULT 'free' NOT NULL,
	"price_monthly" numeric(10, 2),
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"platform_fee_percent" integer DEFAULT 15 NOT NULL,
	"stripe_product_id" varchar(255),
	"stripe_price_id" varchar(255),
	"install_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_apps_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "user_app_installs" ADD CONSTRAINT "user_app_installs_app_id_user_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."user_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_app_oauth_clients" ADD CONSTRAINT "user_app_oauth_clients_app_id_user_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."user_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_app_tokens" ADD CONSTRAINT "user_app_tokens_install_id_user_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."user_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_app_versions" ADD CONSTRAINT "user_app_versions_app_id_user_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."user_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_app_installs_app_workspace_idx" ON "user_app_installs" USING btree ("app_id","workspace_id");--> statement-breakpoint
CREATE INDEX "user_app_installs_workspace_id_idx" ON "user_app_installs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_app_installs_app_id_idx" ON "user_app_installs" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "user_app_oauth_clients_app_id_idx" ON "user_app_oauth_clients" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_app_tokens_token_hash_idx" ON "user_app_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_app_tokens_install_id_idx" ON "user_app_tokens" USING btree ("install_id");--> statement-breakpoint
CREATE INDEX "user_app_tokens_workspace_id_idx" ON "user_app_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_app_versions_app_version_idx" ON "user_app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "user_app_versions_app_id_idx" ON "user_app_versions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "user_apps_owner_workspace_id_idx" ON "user_apps" USING btree ("owner_workspace_id");--> statement-breakpoint
CREATE INDEX "user_apps_visibility_idx" ON "user_apps" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "user_apps_review_status_idx" ON "user_apps" USING btree ("review_status");