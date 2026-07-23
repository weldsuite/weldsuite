CREATE TABLE "crm_pipelines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"icon" varchar(100),
	"color" varchar(50),
	"template" varchar(100),
	"settings" jsonb,
	"is_default" boolean DEFAULT false,
	"is_archived" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "weldagent_user_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"preferred_model" varchar(100) DEFAULT 'openai/gpt-4o' NOT NULL,
	"fallback_model" varchar(100) DEFAULT 'anthropic/claude-sonnet-4-20250514',
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_tokens" integer DEFAULT 4096 NOT NULL,
	"show_tool_calls" boolean DEFAULT true NOT NULL,
	"auto_send_suggestions" boolean DEFAULT false NOT NULL,
	"save_conversation_history" boolean DEFAULT true NOT NULL,
	"app_permissions" jsonb DEFAULT '{"crm":true,"commerce":true,"accounting":true,"wms":true,"mail":true,"helpdesk":true,"parcel":true,"projects":true,"tasks":true,"host":true}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"conversation_id" varchar(30),
	"module_key" varchar(50) NOT NULL,
	"model_id" varchar(100) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"estimated_cost_cents" integer NOT NULL,
	"tools_used" jsonb DEFAULT '[]'::jsonb,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"request_duration_ms" integer,
	"was_streamed" boolean DEFAULT true NOT NULL,
	"finish_reason" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_usage_summary" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255),
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"period_type" varchar(20) NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"total_tool_calls" integer DEFAULT 0 NOT NULL,
	"usage_by_model" jsonb DEFAULT '{}'::jsonb,
	"usage_by_module" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "clerk_membership_id" varchar(255);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "clerk_invitation_id" varchar(255);--> statement-breakpoint
CREATE INDEX "crm_pipelines_workspace_idx" ON "crm_pipelines" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_pipelines_template_idx" ON "crm_pipelines" USING btree ("template");--> statement-breakpoint
CREATE INDEX "crm_pipelines_is_default_idx" ON "crm_pipelines" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "workspace_members_clerk_invitation_idx" ON "workspace_members" USING btree ("clerk_invitation_id");