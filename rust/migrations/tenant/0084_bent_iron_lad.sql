CREATE TABLE "project_tables" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"settings" jsonb
);
--> statement-breakpoint
ALTER TABLE "project_sheets" ADD COLUMN "table_id" varchar(255);--> statement-breakpoint
ALTER TABLE "personal_tasks" ADD COLUMN "repeat" jsonb;--> statement-breakpoint
CREATE INDEX "project_tables_project_idx" ON "project_tables" USING btree ("project_id");