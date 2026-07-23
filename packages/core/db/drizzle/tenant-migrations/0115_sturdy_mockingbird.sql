ALTER TABLE "autonomous_agents" RENAME TO "agents";--> statement-breakpoint
ALTER TABLE "autonomous_agent_runs" RENAME TO "agent_runs";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME COLUMN "autonomous_agent_id" TO "agent_id";--> statement-breakpoint
DROP INDEX "autonomous_agents_status_idx";--> statement-breakpoint
DROP INDEX "autonomous_agents_deleted_at_idx";--> statement-breakpoint
DROP INDEX "autonomous_agent_runs_agent_id_idx";--> statement-breakpoint
DROP INDEX "autonomous_agent_runs_status_idx";--> statement-breakpoint
DROP INDEX "autonomous_agent_runs_created_at_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "system_key" varchar(50);--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "entity_type" varchar(50);--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "entity_display_name" varchar(255);--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_deleted_at_idx" ON "agents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "agents_system_key_idx" ON "agents" USING btree ("system_key");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_channels_entity_idx" ON "chat_channels" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_entity_unique_idx" ON "chat_channels" USING btree ("entity_type","entity_id") WHERE "chat_channels"."entity_type" IS NOT NULL AND "chat_channels"."entity_id" IS NOT NULL;