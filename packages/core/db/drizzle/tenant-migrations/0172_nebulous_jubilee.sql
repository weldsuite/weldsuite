CREATE TABLE "nango_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider_config_key" varchar(100) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"nango_connection_id" varchar(255),
	"display_name" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"scopes" jsonb,
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
CREATE TABLE "nango_sync_runs" (
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
ALTER TABLE "products" ADD COLUMN "track_lots" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_serials" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_expiry" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "nango_sync_runs" ADD CONSTRAINT "nango_sync_runs_connection_id_nango_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."nango_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nango_connections_provider_config_key_unique" ON "nango_connections" USING btree ("provider_config_key");--> statement-breakpoint
CREATE INDEX "nango_connections_nango_connection_id_idx" ON "nango_connections" USING btree ("nango_connection_id");--> statement-breakpoint
CREATE INDEX "nango_connections_status_idx" ON "nango_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nango_connections_deleted_at_idx" ON "nango_connections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "nango_sync_runs_connection_idx" ON "nango_sync_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "nango_sync_runs_status_idx" ON "nango_sync_runs" USING btree ("status");