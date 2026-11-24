CREATE TABLE "weldpass_devices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(100) NOT NULL,
	"platform" varchar(20) NOT NULL,
	"app_version" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX "weldpass_devices_workspace_user_idx" ON "weldpass_devices" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "weldpass_devices_workspace_created_at_idx" ON "weldpass_devices" USING btree ("workspace_id","created_at");