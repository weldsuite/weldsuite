CREATE TABLE "commerce_portal_access" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"person_id" varchar(30) NOT NULL,
	"company_id" varchar(30) NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'invited' NOT NULL,
	"invited_by" varchar(255),
	"invited_at" timestamp,
	"last_login_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commerce_portal_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"is_enabled" integer DEFAULT 0 NOT NULL,
	"display_name" varchar(255),
	"logo" varchar(500),
	"primary_color" varchar(20),
	"accent_color" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "weldagent_agents" ALTER COLUMN "model_id" SET DEFAULT '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_portal_access_person_company_uidx" ON "commerce_portal_access" USING btree ("person_id","company_id");
--> statement-breakpoint
CREATE INDEX "commerce_portal_access_email_idx" ON "commerce_portal_access" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "commerce_portal_access_company_idx" ON "commerce_portal_access" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "commerce_portal_access_status_idx" ON "commerce_portal_access" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "commerce_portal_settings_enabled_idx" ON "commerce_portal_settings" USING btree ("is_enabled");
