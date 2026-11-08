ALTER TABLE "tasks" ADD COLUMN "source_type" varchar(30);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_articles" ADD COLUMN "audience_company_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "helpdesk_articles" ADD COLUMN "locale" varchar(10);--> statement-breakpoint
ALTER TABLE "helpdesk_articles" ADD COLUMN "translation_of_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "parent_conversation_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "is_major_incident" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "merged_into_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "impact" varchar(10);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "urgency" varchar(10);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "language" varchar(10);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "escalation_check_at" timestamp;--> statement-breakpoint
CREATE INDEX "tasks_source_idx" ON "tasks" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_translation_of_idx" ON "helpdesk_articles" USING btree ("translation_of_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_parent_idx" ON "desk_conversations" USING btree ("parent_conversation_id") WHERE "desk_conversations"."parent_conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_conversations_merged_into_idx" ON "desk_conversations" USING btree ("merged_into_id") WHERE "desk_conversations"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_conversations_escalation_check_idx" ON "desk_conversations" USING btree ("escalation_check_at") WHERE "desk_conversations"."escalation_check_at" IS NOT NULL;