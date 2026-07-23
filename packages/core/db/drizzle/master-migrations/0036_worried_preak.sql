CREATE TYPE "public"."admin_role" AS ENUM('superadmin', 'admin', 'viewer');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255),
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"role" "admin_role" DEFAULT 'admin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by" varchar(255),
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "admin_users_user_id_idx" ON "admin_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_users_is_active_idx" ON "admin_users" USING btree ("is_active");