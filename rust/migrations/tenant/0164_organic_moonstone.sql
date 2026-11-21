CREATE TABLE "app_kv" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_code" varchar(50) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_records" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"app_code" varchar(50) NOT NULL,
	"collection" varchar(100) NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" ADD COLUMN "app_type" varchar(20) DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" ADD COLUMN "user_app_id" varchar(30);--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" ADD COLUMN "granted_scopes" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "app_kv_app_key_idx" ON "app_kv" USING btree ("app_code","key");--> statement-breakpoint
CREATE INDEX "app_records_app_collection_idx" ON "app_records" USING btree ("app_code","collection");--> statement-breakpoint
CREATE INDEX "app_records_created_at_idx" ON "app_records" USING btree ("created_at");