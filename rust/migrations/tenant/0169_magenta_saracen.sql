DROP INDEX "cfd_entity_type_slug_idx";--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "assignee_ids" jsonb;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "repeat" jsonb;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "change_log" jsonb;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "send_provider" varchar(50);--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "provider_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "mailgun_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "snoozed_until" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "snoozed_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "unsnoozed_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "unsnoozed_early" boolean;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "resnoozed_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "unsnooze_trigger_run_id" varchar(255);--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "ticket_type_id" varchar(30);--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "task_priority" varchar(20);--> statement-breakpoint
CREATE INDEX "mail_messages_snoozed_until_idx" ON "mail_messages" USING btree ("snoozed_until");--> statement-breakpoint
CREATE INDEX "mail_messages_scheduled_for_idx" ON "mail_messages" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_entity_type_slug_ticket_type_idx" ON "custom_field_definitions" USING btree ("entity_type","slug","ticket_type_id") WHERE "custom_field_definitions"."ticket_type_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_entity_type_slug_idx" ON "custom_field_definitions" USING btree ("entity_type","slug") WHERE "custom_field_definitions"."ticket_type_id" IS NULL;