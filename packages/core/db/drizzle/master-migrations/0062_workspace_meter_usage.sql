CREATE TABLE "workspace_meter_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"meter" varchar(50) NOT NULL,
	"period" varchar(7) NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"blocks_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_meter_usage_workspace_meter_period_idx" ON "workspace_meter_usage" USING btree ("workspace_id","meter","period");--> statement-breakpoint
CREATE INDEX "workspace_meter_usage_workspace_period_idx" ON "workspace_meter_usage" USING btree ("workspace_id","period");