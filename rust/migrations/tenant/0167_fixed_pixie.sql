CREATE TABLE "active_timers" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"project_id" varchar(255),
	"task_id" varchar(255),
	"user_id" varchar(255) NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"description" text,
	"activity" varchar(100),
	"billable" boolean DEFAULT true NOT NULL,
	"rate" numeric(10, 2)
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "pinned_by" varchar(255);--> statement-breakpoint
ALTER TABLE "active_timers" ADD CONSTRAINT "active_timers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_timers" ADD CONSTRAINT "active_timers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_timers_user_idx" ON "active_timers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "active_timers_project_idx" ON "active_timers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "active_timers_task_idx" ON "active_timers" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "files_is_pinned_idx" ON "files" USING btree ("is_pinned");