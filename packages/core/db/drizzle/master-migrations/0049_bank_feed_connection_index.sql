CREATE TABLE "bank_feed_connection_index" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"provider" varchar(30) NOT NULL,
	"provider_connection_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sync_interval_hours" integer DEFAULT 24 NOT NULL,
	"next_sync_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_connection_index_provider_uidx" ON "bank_feed_connection_index" USING btree ("provider","provider_connection_id");--> statement-breakpoint
CREATE INDEX "bank_feed_connection_index_org_idx" ON "bank_feed_connection_index" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE INDEX "bank_feed_connection_index_next_sync_idx" ON "bank_feed_connection_index" USING btree ("next_sync_at");