CREATE TABLE "ai_agent_definitions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text NOT NULL,
	"model_id" varchar(100) DEFAULT 'openai/gpt-4o' NOT NULL,
	"temperature" numeric(3, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"enabled_builtin_tools" jsonb DEFAULT '[]'::jsonb,
	"integration_ids" jsonb DEFAULT '[]'::jsonb,
	"max_iterations" integer DEFAULT 10 NOT NULL,
	"max_total_tokens" integer DEFAULT 20000 NOT NULL,
	"escalation_rules" jsonb,
	"module_key" varchar(30) DEFAULT 'general' NOT NULL,
	"created_by" varchar(255),
	"total_runs" integer DEFAULT 0 NOT NULL,
	"avg_tokens_per_run" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_agent_execution_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"execution_id" varchar(30),
	"step_id" varchar(50),
	"agent_definition_id" varchar(30),
	"conversation_id" varchar(30),
	"status" varchar(20) NOT NULL,
	"total_iterations" integer DEFAULT 0 NOT NULL,
	"total_tokens_used" integer DEFAULT 0 NOT NULL,
	"total_credits_used" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"iterations" jsonb DEFAULT '[]'::jsonb,
	"messages_sent" jsonb DEFAULT '[]'::jsonb,
	"escalated_to" varchar(255),
	"escalation_reason" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "settings" jsonb;--> statement-breakpoint
CREATE INDEX "ai_agent_definitions_module_key_idx" ON "ai_agent_definitions" USING btree ("module_key");--> statement-breakpoint
CREATE INDEX "ai_agent_definitions_deleted_at_idx" ON "ai_agent_definitions" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ai_agent_exec_logs_execution_id_idx" ON "ai_agent_execution_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "ai_agent_exec_logs_agent_def_id_idx" ON "ai_agent_execution_logs" USING btree ("agent_definition_id");--> statement-breakpoint
CREATE INDEX "ai_agent_exec_logs_conversation_id_idx" ON "ai_agent_execution_logs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_agent_exec_logs_status_idx" ON "ai_agent_execution_logs" USING btree ("status");