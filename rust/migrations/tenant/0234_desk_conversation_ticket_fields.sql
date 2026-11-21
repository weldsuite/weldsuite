ALTER TABLE "desk_conversations" ADD COLUMN "ticket_type_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "priority" varchar(10);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "department_id" varchar(30);--> statement-breakpoint
CREATE INDEX "desk_conversations_ticket_type_idx" ON "desk_conversations" USING btree ("ticket_type_id","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_priority_idx" ON "desk_conversations" USING btree ("priority","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_department_idx" ON "desk_conversations" USING btree ("department_id","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_tags_gin" ON "desk_conversations" USING gin ("tags");