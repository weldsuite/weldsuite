CREATE TABLE "system_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"category" varchar(50) DEFAULT 'general' NOT NULL,
	"value" jsonb,
	"description" text,
	"data_type" varchar(20) DEFAULT 'string',
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "mail_contacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "helpdesk_contacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mail_contacts" CASCADE;--> statement-breakpoint
DROP TABLE "helpdesk_contacts" CASCADE;--> statement-breakpoint
ALTER TABLE "crm_activities" ALTER COLUMN "assigned_to_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "system_settings_category_idx" ON "system_settings" USING btree ("category");