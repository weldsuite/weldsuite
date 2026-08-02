ALTER TABLE "project_files" ADD COLUMN "parent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_parent_id_project_files_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."project_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_files_parent_idx" ON "project_files" USING btree ("parent_id");
