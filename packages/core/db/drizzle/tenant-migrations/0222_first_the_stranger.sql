CREATE TABLE "weldagent_agent_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"agent_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weldagent_conversations" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "owner_id" varchar(255);--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "visibility" varchar(20) DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "subagent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "delegate_to_self" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_worker_agent_id" varchar(100);--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_worker_agent_version" integer;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_worker_config_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "weldagent_agent_members_agent_user_idx" ON "weldagent_agent_members" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE INDEX "weldagent_agent_members_user_idx" ON "weldagent_agent_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weldagent_conversations_main_idx" ON "weldagent_conversations" USING btree ("user_id","agent_id") WHERE "weldagent_conversations"."is_main" = true AND "weldagent_conversations"."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "weldagent_agents" SET "owner_id" = "created_by" WHERE "owner_id" IS NULL;