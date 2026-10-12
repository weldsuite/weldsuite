CREATE TABLE "reach_routes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"kind" varchar(30) NOT NULL,
	"external_id" varchar(100) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"tenant_entity_id" varchar(30) NOT NULL,
	"mailbox_type" varchar(20),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_app_access" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"app_code" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'requested' NOT NULL,
	"request" jsonb,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" varchar(255),
	"requested_at" timestamp with time zone,
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"rejection_reason" text,
	"suspended_reason" text,
	"stripe_subscription_id" varchar(255),
	"billing_status" varchar(20) DEFAULT 'none' NOT NULL,
	"billing_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_catalog" ADD COLUMN "requires_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reach_routes_kind_external_idx" ON "reach_routes" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "reach_routes_workspace_idx" ON "reach_routes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reach_routes_kind_status_idx" ON "reach_routes" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_app_access_workspace_app_idx" ON "workspace_app_access" USING btree ("workspace_id","app_code");--> statement-breakpoint
CREATE INDEX "workspace_app_access_app_status_idx" ON "workspace_app_access" USING btree ("app_code","status");