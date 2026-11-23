CREATE TABLE "workflow_trigger_index" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30) NOT NULL,
	"trigger_id" varchar(30) NOT NULL,
	"category" varchar(30) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"entity_type" varchar(100),
	"event_type" varchar(50),
	"provider" varchar(100),
	"integration_event" varchar(150),
	"integration_id" varchar(30),
	"source_workflow_id" varchar(30),
	"filters" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_trigger_index_workflow_trigger_uidx" ON "workflow_trigger_index" USING btree ("workflow_id","trigger_id");--> statement-breakpoint
CREATE INDEX "workflow_trigger_index_workflow_idx" ON "workflow_trigger_index" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_trigger_index_category_idx" ON "workflow_trigger_index" USING btree ("category");--> statement-breakpoint
CREATE INDEX "workflow_trigger_index_entity_event_idx" ON "workflow_trigger_index" USING btree ("category","entity_type","event_type","is_enabled");--> statement-breakpoint
CREATE INDEX "workflow_trigger_index_integration_event_idx" ON "workflow_trigger_index" USING btree ("category","provider","integration_event","is_enabled");--> statement-breakpoint
CREATE INDEX "workflow_trigger_index_source_workflow_idx" ON "workflow_trigger_index" USING btree ("source_workflow_id");