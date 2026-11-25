ALTER TABLE "project_lessons" DROP CONSTRAINT "project_lessons_category_check";--> statement-breakpoint
ALTER TABLE "project_lessons" ADD COLUMN "sprint_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "epic_id" varchar(30);--> statement-breakpoint
CREATE INDEX "project_lessons_sprint_idx" ON "project_lessons" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "tasks_epic_idx" ON "tasks" USING btree ("epic_id");--> statement-breakpoint
ALTER TABLE "project_lessons" ADD CONSTRAINT "project_lessons_category_check" CHECK ("project_lessons"."category" in ('went_well', 'went_badly', 'do_differently', 'action'));