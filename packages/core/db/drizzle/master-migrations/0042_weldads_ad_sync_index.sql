CREATE TABLE "ad_sync_index" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_metrics_sync_at" timestamp with time zone,
	"metrics_interval_hours" integer DEFAULT 6 NOT NULL,
	"webhook_subscribed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_sync_index" ADD CONSTRAINT "ad_sync_index_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_sync_index_workspace_connection_idx" ON "ad_sync_index" USING btree ("workspace_id","connection_id");--> statement-breakpoint
CREATE INDEX "ad_sync_index_next_metrics_sync_at_idx" ON "ad_sync_index" USING btree ("next_metrics_sync_at");--> statement-breakpoint
CREATE INDEX "ad_sync_index_is_enabled_idx" ON "ad_sync_index" USING btree ("is_enabled");
