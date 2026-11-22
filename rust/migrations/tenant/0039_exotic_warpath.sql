CREATE TABLE "enrichment_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"provider" varchar(50) NOT NULL,
	"operation" varchar(50) NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"request_params" jsonb,
	"response_data" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"credits_used" integer,
	"trigger_task_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "enrich_field_definitions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider" varchar(50) NOT NULL,
	"operation" varchar(50) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"config" jsonb
);
--> statement-breakpoint
CREATE TABLE "enrich_field_results" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"enrich_field_id" varchar(30) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"operation" varchar(50) NOT NULL,
	"status" varchar(30) NOT NULL,
	"result_data" jsonb,
	"enrichment_log_id" varchar(30)
);
--> statement-breakpoint
CREATE INDEX "enrichment_logs_entity_idx" ON "enrichment_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "enrichment_logs_provider_idx" ON "enrichment_logs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "enrichment_logs_created_at_idx" ON "enrichment_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "enrichment_logs_status_idx" ON "enrichment_logs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "enrich_field_def_provider_op_entity_idx" ON "enrich_field_definitions" USING btree ("provider","operation","entity_type");--> statement-breakpoint
CREATE INDEX "enrich_field_def_entity_type_idx" ON "enrich_field_definitions" USING btree ("entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "enrich_field_results_field_entity_idx" ON "enrich_field_results" USING btree ("enrich_field_id","entity_id");--> statement-breakpoint
CREATE INDEX "enrich_field_results_entity_idx" ON "enrich_field_results" USING btree ("entity_type","entity_id");