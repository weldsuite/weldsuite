ALTER TABLE "weldagent_agents" ALTER COLUMN "model_id" SET DEFAULT 'claude-opus-5-5';--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_agent_id" varchar(100);--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_agent_version" integer;--> statement-breakpoint
ALTER TABLE "weldagent_agents" ADD COLUMN "anthropic_config_hash" varchar(64);