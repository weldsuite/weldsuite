CREATE TABLE "contact_external_identities" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	"provider" varchar(30) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"external_name" varchar(255),
	"external_email" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_execution_steps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_error_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_variables" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "helpdesk_workflow_execution_steps" CASCADE;--> statement-breakpoint
DROP TABLE "helpdesk_workflow_error_logs" CASCADE;--> statement-breakpoint
DROP TABLE "helpdesk_workflow_variables" CASCADE;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "source_type" varchar(20);--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "source_id" varchar(30);--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "auto_scheduled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meeting_messages" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "meeting_messages" ADD COLUMN "pinned_by" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "contact_ext_id_provider_external_unique" ON "contact_external_identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "contact_ext_id_contact_idx" ON "contact_external_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_ext_id_email_idx" ON "contact_external_identities" USING btree ("external_email");--> statement-breakpoint
CREATE INDEX "calendar_events_source_idx" ON "calendar_events" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "calendar_events_auto_scheduled_idx" ON "calendar_events" USING btree ("auto_scheduled");