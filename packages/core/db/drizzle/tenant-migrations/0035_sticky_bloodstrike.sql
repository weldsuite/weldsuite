CREATE TABLE "personal_tasks" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"priority" varchar(20) DEFAULT 'medium',
	"project_id" varchar(255),
	"assignee_id" varchar(255),
	"due_date" timestamp,
	"completed_at" timestamp,
	"archived_at" timestamp,
	"is_important" boolean DEFAULT false NOT NULL,
	"tags" jsonb,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_projects" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"color" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "task_tags" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "contact_list_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"list_id" varchar(30) NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	CONSTRAINT "contact_list_members_unique_idx" UNIQUE("list_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_credits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_packages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weldagent_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weldagent_usage_summary" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "workspace_credits" CASCADE;--> statement-breakpoint
DROP TABLE "credit_packages" CASCADE;--> statement-breakpoint
DROP TABLE "credit_transactions" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_usage" CASCADE;--> statement-breakpoint
DROP TABLE "weldagent_usage" CASCADE;--> statement-breakpoint
DROP TABLE "weldagent_usage_summary" CASCADE;--> statement-breakpoint
ALTER TABLE "device_tokens" ALTER COLUMN "token_type" SET DEFAULT 'expo';--> statement-breakpoint
CREATE INDEX "personal_tasks_user_idx" ON "personal_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personal_tasks_status_idx" ON "personal_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "personal_tasks_project_idx" ON "personal_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "personal_tasks_assignee_idx" ON "personal_tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "personal_tasks_important_idx" ON "personal_tasks" USING btree ("is_important");--> statement-breakpoint
CREATE INDEX "personal_tasks_due_date_idx" ON "personal_tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "task_projects_user_idx" ON "task_projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_tags_user_idx" ON "task_tags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contact_list_members_list_id_idx" ON "contact_list_members" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "contact_list_members_contact_id_idx" ON "contact_list_members" USING btree ("contact_id");--> statement-breakpoint
DROP TYPE "public"."credit_service_type";--> statement-breakpoint
DROP TYPE "public"."credit_transaction_type";