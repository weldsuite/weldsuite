DROP TABLE IF EXISTS "nango_sync_runs";--> statement-breakpoint
DROP TABLE IF EXISTS "nango_connections";--> statement-breakpoint
CREATE TABLE "connector_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider" varchar(100) NOT NULL,
	"display_name" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"credentials" jsonb,
	"external_account_id" varchar(255),
	"enabled_syncs" jsonb,
	"sync_watermarks" jsonb,
	"last_sync_at" timestamp,
	"last_sync_status" varchar(20),
	"last_error" text,
	"last_error_at" timestamp,
	"records_synced" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp,
	"connected_by" varchar(255),
	"disconnected_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "connector_sync_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"sync_name" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"sync_type" varchar(20),
	"records_added" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_deleted" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_modified" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer,
	"error" text,
	"error_samples" jsonb
);
--> statement-breakpoint
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_provider_unique" ON "connector_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "connector_connections_status_idx" ON "connector_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "connector_connections_deleted_at_idx" ON "connector_connections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "connector_sync_runs_connection_idx" ON "connector_sync_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_sync_runs_status_idx" ON "connector_sync_runs" USING btree ("status");
