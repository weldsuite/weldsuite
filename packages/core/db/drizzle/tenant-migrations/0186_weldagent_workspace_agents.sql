-- Workspace AI agents (WeldAgent) — named, permission-scoped agents.
-- Distinct from helpdesk_agents (human support roster).

CREATE TABLE IF NOT EXISTS "weldagent_agents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"icon" varchar(50),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model_id" varchar(100) DEFAULT 'anthropic/claude-sonnet-4-5' NOT NULL,
	"temperature" varchar(10) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer DEFAULT 2048 NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_iterations" integer DEFAULT 10 NOT NULL,
	"max_total_tokens" integer DEFAULT 20000 NOT NULL,
	"created_by" varchar(255),
	"total_runs" integer DEFAULT 0 NOT NULL,
	"successful_runs" integer DEFAULT 0 NOT NULL,
	"failed_runs" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "weldagent_agent_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"status" varchar(20) NOT NULL,
	"trigger_type" varchar(20),
	"trigger_data" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"total_iterations" integer DEFAULT 0,
	"total_tokens_used" integer DEFAULT 0,
	"tool_call_count" integer DEFAULT 0,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "weldagent_conversations" ADD COLUMN IF NOT EXISTS "agent_id" varchar(30);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "weldagent_agents_status_idx" ON "weldagent_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weldagent_agents_deleted_at_idx" ON "weldagent_agents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weldagent_agent_runs_agent_id_idx" ON "weldagent_agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weldagent_agent_runs_status_idx" ON "weldagent_agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weldagent_agent_runs_created_at_idx" ON "weldagent_agent_runs" USING btree ("created_at");
