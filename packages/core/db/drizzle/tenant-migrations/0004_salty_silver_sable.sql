CREATE TABLE "external_webhooks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" varchar(255) NOT NULL,
	"headers" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"consecutive_failures" integer DEFAULT 0,
	"last_failed_at" timestamp with time zone,
	"last_failure_reason" text,
	"last_delivered_at" timestamp with time zone,
	"total_deliveries" integer DEFAULT 0,
	"total_failures" integer DEFAULT 0,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"webhook_id" varchar(30) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"event_id" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"response_time_ms" integer,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"max_retries" integer DEFAULT 5,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "external_webhooks_workspace_idx" ON "external_webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_webhooks_status_idx" ON "external_webhooks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_idx" ON "webhook_deliveries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_retry_idx" ON "webhook_deliveries" USING btree ("next_retry_at");