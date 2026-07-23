DROP TABLE "weldagent_user_settings" CASCADE;--> statement-breakpoint
DROP TABLE "weldagent_conversations" CASCADE;--> statement-breakpoint
DROP TABLE "weldagent_messages" CASCADE;--> statement-breakpoint
DROP TABLE "ai_agent_definitions" CASCADE;--> statement-breakpoint
DROP TABLE "ai_agent_execution_logs" CASCADE;--> statement-breakpoint
DROP TABLE "agents" CASCADE;--> statement-breakpoint
DROP TABLE "agent_runs" CASCADE;--> statement-breakpoint
DROP TABLE "agent_packages" CASCADE;--> statement-breakpoint
ALTER TABLE "helpdesk_settings" DROP COLUMN "weldagent_config";