CREATE TABLE "workspace_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"task_executions_this_month" integer DEFAULT 0 NOT NULL,
	"task_executions_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"emails_sent_this_month" integer DEFAULT 0 NOT NULL,
	"emails_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_credits_used_this_month" integer DEFAULT 0 NOT NULL,
	"ai_credits_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"storage_used" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE INDEX "workspace_usage_workspace_id_idx" ON "workspace_usage" USING btree ("workspace_id");