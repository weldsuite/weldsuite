ALTER TABLE "audit_logs" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs" USING btree ("performed_by");