CREATE TYPE "public"."membership_status" AS ENUM('ACTIVE', 'PENDING');--> statement-breakpoint
CREATE TABLE "user_workspaces" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_membership_id" varchar(255),
	"role" varchar(50) DEFAULT 'org:member' NOT NULL,
	"status" "membership_status" DEFAULT 'ACTIVE' NOT NULL,
	"invited_by" varchar(255),
	"invited_at" timestamp,
	"joined_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"first_name" varchar(255),
	"last_name" varchar(255),
	"image_url" varchar(500),
	"phone" varchar(50),
	"nickname" varchar(255),
	"job_title" varchar(255),
	"bio" text,
	"timezone" varchar(100) DEFAULT 'UTC',
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_url" varchar(500);--> statement-breakpoint
ALTER TABLE "user_workspaces" ADD CONSTRAINT "user_workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspaces" ADD CONSTRAINT "user_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspaces" ADD CONSTRAINT "user_workspaces_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_workspaces_user_workspace_idx" ON "user_workspaces" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "user_workspaces_user_id_idx" ON "user_workspaces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_workspaces_workspace_id_idx" ON "user_workspaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_workspaces_status_idx" ON "user_workspaces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_workspaces_clerk_membership_id_idx" ON "user_workspaces" USING btree ("clerk_membership_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_is_active_idx" ON "users" USING btree ("is_active");