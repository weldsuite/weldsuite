CREATE TABLE "integration_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider" varchar(30) NOT NULL,
	"name" varchar(255),
	"status" varchar(20) DEFAULT 'inactive' NOT NULL,
	"direction" varchar(15) DEFAULT 'inbound' NOT NULL,
	"oauth_tokens" jsonb,
	"webhook_id" varchar(255),
	"webhook_secret" text,
	"sync_settings" jsonb,
	"field_mappings" jsonb,
	"last_sync_at" timestamp,
	"last_sync_status" varchar(20),
	"last_error" text,
	"last_error_at" timestamp,
	"companies_synced" integer DEFAULT 0 NOT NULL,
	"people_synced" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp,
	"connected_by" varchar(255),
	"trigger_schedule_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "integration_entity_mappings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"external_entity_type" varchar(50) NOT NULL,
	"external_entity_id" varchar(255) NOT NULL,
	"internal_entity_type" varchar(50) NOT NULL,
	"internal_entity_id" varchar(30) NOT NULL,
	"last_synced_at" timestamp,
	"sync_checksum" varchar(64)
);
--> statement-breakpoint
CREATE INDEX "integration_connections_provider_idx" ON "integration_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "integration_connections_status_idx" ON "integration_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_entity_mappings_unique" ON "integration_entity_mappings" USING btree ("connection_id","external_entity_type","external_entity_id");--> statement-breakpoint
CREATE INDEX "integration_entity_mappings_connection_idx" ON "integration_entity_mappings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "integration_entity_mappings_external_idx" ON "integration_entity_mappings" USING btree ("external_entity_type","external_entity_id");--> statement-breakpoint
CREATE INDEX "integration_entity_mappings_internal_idx" ON "integration_entity_mappings" USING btree ("internal_entity_type","internal_entity_id");