ALTER TABLE "audit_logs" ADD COLUMN "event_id" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_event_id_idx" ON "audit_logs" USING btree ("event_id");