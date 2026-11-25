ALTER TABLE "project_lessons" ADD COLUMN "sprint_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "epic_id" varchar(30);--> statement-breakpoint
CREATE INDEX "project_lessons_sprint_idx" ON "project_lessons" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "tasks_epic_idx" ON "tasks" USING btree ("epic_id");