ALTER TABLE "desk_conversations" ADD COLUMN "first_response_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "first_response_seconds" integer;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "resolution_seconds" integer;--> statement-breakpoint
CREATE INDEX "desk_conversations_created_at_idx" ON "desk_conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "desk_conversations_first_response_at_idx" ON "desk_conversations" USING btree ("first_response_at");--> statement-breakpoint
CREATE INDEX "desk_conversations_resolved_at_idx" ON "desk_conversations" USING btree ("resolved_at");