CREATE TABLE "notifications" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"category" varchar(50) DEFAULT 'system' NOT NULL,
	"notification_type" varchar(50) DEFAULT 'custom' NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(30),
	"action_url" varchar(500),
	"icon" varchar(50),
	"severity" varchar(20) DEFAULT 'info' NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"delivered_in_app" boolean DEFAULT true NOT NULL,
	"delivered_email" boolean DEFAULT false NOT NULL,
	"delivered_push" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"do_not_disturb" boolean DEFAULT false NOT NULL,
	"sound_enabled" boolean DEFAULT true NOT NULL,
	"module_preferences" jsonb,
	"default_in_app" boolean DEFAULT true NOT NULL,
	"default_email" boolean DEFAULT false NOT NULL,
	"default_push" boolean DEFAULT true NOT NULL,
	"default_desktop" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_user_workspace_idx" ON "notifications" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","is_read");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_category_idx" ON "notifications" USING btree ("category");--> statement-breakpoint
CREATE INDEX "notifications_entity_idx" ON "notifications" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_workspace_idx" ON "notification_preferences" USING btree ("user_id","workspace_id");