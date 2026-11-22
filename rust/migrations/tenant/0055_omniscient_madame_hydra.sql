CREATE TABLE "audit_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"action" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"changes" jsonb,
	"performed_by" varchar(255),
	"performed_by_name" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");