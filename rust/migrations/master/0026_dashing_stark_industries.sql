CREATE TABLE "agent_packages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" varchar(50) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"stripe_price_id" text,
	"session_token_limit" integer NOT NULL,
	"weekly_token_limit" integer NOT NULL,
	"token_multiplier" numeric(5, 2) DEFAULT '1.00' NOT NULL,
	"default_model_id" varchar(100) DEFAULT 'claude-opus-4-7' NOT NULL,
	"default_system_prompt" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_purchases" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"agent_package_id" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"stripe_subscription_item_id" text,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "weldagent_usage" ADD COLUMN "agent_id" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_packages_slug_unique" ON "agent_packages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agent_packages_is_active_idx" ON "agent_packages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "agent_packages_is_default_idx" ON "agent_packages" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "wap_workspace_idx" ON "workspace_agent_purchases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wap_status_idx" ON "workspace_agent_purchases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wap_workspace_package_unique" ON "workspace_agent_purchases" USING btree ("workspace_id","agent_package_id");--> statement-breakpoint
CREATE INDEX "weldagent_usage_agent_window_idx" ON "weldagent_usage" USING btree ("workspace_id","agent_id","created_at");