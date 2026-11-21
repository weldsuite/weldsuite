CREATE TABLE "weldagent_agent_skills" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"skill_id" varchar(30) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"conversation_id" varchar(30),
	"tool_name" varchar(100) NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" varchar(20) DEFAULT 'high' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" varchar(255),
	"decided_at" timestamp with time zone,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_memories" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"kind" varchar(20) DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"source" varchar(100),
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weldagent_routine_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"routine_id" varchar(30) NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"trigger" varchar(40) DEFAULT 'schedule' NOT NULL,
	"summary" text,
	"error" text,
	"agent_run_id" varchar(30),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_routines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"instructions" text NOT NULL,
	"skill_id" varchar(30),
	"schedule_kind" varchar(20) DEFAULT 'cron' NOT NULL,
	"cron_expr" varchar(100),
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"event_key" varchar(100),
	"connector_config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weldagent_skills" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"instructions" text NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" varchar(255),
	"source_agent_id" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weldagent_teach_sessions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'recording' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_id" varchar(30),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"share_token" varchar(64),
	"source_agent_id" varchar(30),
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "weldagent_agent_skills_unique" ON "weldagent_agent_skills" USING btree ("agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "weldagent_agent_skills_agent_idx" ON "weldagent_agent_skills" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "weldagent_approvals_agent_idx" ON "weldagent_approvals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "weldagent_approvals_status_idx" ON "weldagent_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "weldagent_memories_agent_idx" ON "weldagent_memories" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "weldagent_memories_kind_idx" ON "weldagent_memories" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "weldagent_routine_runs_routine_idx" ON "weldagent_routine_runs" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX "weldagent_routine_runs_created_idx" ON "weldagent_routine_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "weldagent_routines_agent_idx" ON "weldagent_routines" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "weldagent_routines_next_run_idx" ON "weldagent_routines" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "weldagent_routines_enabled_idx" ON "weldagent_routines" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "weldagent_skills_status_idx" ON "weldagent_skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "weldagent_skills_deleted_at_idx" ON "weldagent_skills" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "weldagent_teach_sessions_agent_idx" ON "weldagent_teach_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weldagent_templates_share_token_idx" ON "weldagent_templates" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "weldagent_templates_public_idx" ON "weldagent_templates" USING btree ("is_public");