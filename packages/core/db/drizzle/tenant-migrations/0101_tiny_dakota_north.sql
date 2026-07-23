ALTER TABLE "personal_tasks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "personal_tasks" CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "customer_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "contact_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "calendar_event_id" varchar(30);--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "working_hours" jsonb;--> statement-breakpoint
CREATE INDEX "tasks_customer_idx" ON "tasks" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "tasks" USING btree ("contact_id");