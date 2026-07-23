CREATE TABLE "integration_field_mappings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"external_field_path" varchar(255) NOT NULL,
	"internal_field_path" varchar(255) NOT NULL,
	"direction" varchar(15) DEFAULT 'bidirectional' NOT NULL,
	"transform_type" varchar(30) DEFAULT 'direct' NOT NULL,
	"transform_config" jsonb,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_conflicts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"internal_entity_id" varchar(30) NOT NULL,
	"external_entity_id" varchar(255) NOT NULL,
	"conflict_type" varchar(30) NOT NULL,
	"internal_data" jsonb NOT NULL,
	"external_data" jsonb NOT NULL,
	"conflict_fields" jsonb,
	"resolution" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "sync_logs" ADD COLUMN "direction" varchar(15);--> statement-breakpoint
ALTER TABLE "sync_logs" ADD COLUMN "entity_type" varchar(50);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "entity_config" jsonb;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "sync_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "conflict_strategy" varchar(30) DEFAULT 'last_write_wins' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "leads_synced" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "opportunities_synced" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "activities_synced" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "integration_field_mappings_connection_entity_idx" ON "integration_field_mappings" USING btree ("connection_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_field_mappings_unique_field" ON "integration_field_mappings" USING btree ("connection_id","entity_type","external_field_path");--> statement-breakpoint
CREATE INDEX "integration_sync_conflicts_connection_resolution_idx" ON "integration_sync_conflicts" USING btree ("connection_id","resolution");--> statement-breakpoint
CREATE INDEX "integration_sync_conflicts_entity_idx" ON "integration_sync_conflicts" USING btree ("entity_type","internal_entity_id");