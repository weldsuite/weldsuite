ALTER TABLE "project_documents" ALTER COLUMN "content_type" SET DEFAULT 'json';--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "parent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "content_json" jsonb;--> statement-breakpoint
CREATE INDEX "project_documents_parent_idx" ON "project_documents" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "project_documents_parent_position_idx" ON "project_documents" USING btree ("parent_id","position");