ALTER TABLE "project_files" ADD COLUMN "parent_id" varchar(255);--> statement-breakpoint
CREATE INDEX "project_files_parent_idx" ON "project_files" USING btree ("parent_id");
