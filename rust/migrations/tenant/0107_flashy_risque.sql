-- Autonomous AI Agents — idempotent migration
-- Handles both fresh databases and databases with the old schema

-- Drop old columns/indexes if they exist from a previous version
DROP INDEX IF EXISTS "autonomous_agents_module_key_idx";--> statement-breakpoint

-- Create tables if they don't exist yet
CREATE TABLE IF NOT EXISTS "autonomous_agents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" text NOT NULL,
	"description" text,
	"icon" varchar(50),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model_id" varchar(100) DEFAULT 'anthropic/claude-opus-4-6' NOT NULL,
	"temperature" numeric(3, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"enabled_tools" jsonb DEFAULT '[]'::jsonb,
	"integration_ids" jsonb DEFAULT '[]'::jsonb,
	"integration_tool_permissions" jsonb DEFAULT '{}'::jsonb,
	"event_subscriptions" jsonb DEFAULT '[]'::jsonb,
	"max_iterations" integer DEFAULT 10 NOT NULL,
	"max_total_tokens" integer DEFAULT 20000 NOT NULL,
	"is_supervisor" boolean DEFAULT false NOT NULL,
	"sub_agent_ids" text[] DEFAULT '{}',
	"created_by" varchar(255),
	"total_runs" integer DEFAULT 0 NOT NULL,
	"successful_runs" integer DEFAULT 0 NOT NULL,
	"failed_runs" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"last_run_status" varchar(20),
	"trigger_dev_schedule_id" varchar(255)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "autonomous_agent_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"autonomous_agent_id" varchar(30) NOT NULL,
	"status" varchar(20) NOT NULL,
	"trigger_type" varchar(20),
	"trigger_data" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"total_iterations" integer DEFAULT 0,
	"total_tokens_used" integer DEFAULT 0,
	"tool_call_count" integer DEFAULT 0,
	"result" jsonb,
	"error" text
);--> statement-breakpoint

-- Drop old columns if they exist (from previous schema version)
ALTER TABLE "autonomous_agents" DROP COLUMN IF EXISTS "trigger_type";--> statement-breakpoint
ALTER TABLE "autonomous_agents" DROP COLUMN IF EXISTS "trigger_config";--> statement-breakpoint
ALTER TABLE "autonomous_agents" DROP COLUMN IF EXISTS "module_key";--> statement-breakpoint

-- Add new columns if missing
ALTER TABLE "autonomous_agents" ADD COLUMN IF NOT EXISTS "event_subscriptions" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint

-- Update defaults
ALTER TABLE "autonomous_agents" ALTER COLUMN "model_id" SET DEFAULT 'anthropic/claude-opus-4-6';--> statement-breakpoint

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS "autonomous_agents_status_idx" ON "autonomous_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_agents_deleted_at_idx" ON "autonomous_agents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_agent_runs_agent_id_idx" ON "autonomous_agent_runs" USING btree ("autonomous_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_agent_runs_status_idx" ON "autonomous_agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_agent_runs_created_at_idx" ON "autonomous_agent_runs" USING btree ("created_at");
