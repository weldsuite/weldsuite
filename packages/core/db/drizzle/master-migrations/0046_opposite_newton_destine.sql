CREATE TABLE "user_app_dev_sessions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_id" varchar(30) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_apps" ADD COLUMN "publisher_type" varchar(20) DEFAULT 'community' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_apps" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "user_apps" ADD COLUMN "privacy_url" text;--> statement-breakpoint
ALTER TABLE "user_apps" ADD COLUMN "screenshots" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "user_apps" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "user_app_dev_sessions" ADD CONSTRAINT "user_app_dev_sessions_app_id_user_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."user_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_app_dev_sessions_app_user_workspace_idx" ON "user_app_dev_sessions" USING btree ("app_id","user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "user_app_dev_sessions_app_id_idx" ON "user_app_dev_sessions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "user_app_dev_sessions_expires_at_idx" ON "user_app_dev_sessions" USING btree ("expires_at");
