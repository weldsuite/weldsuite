CREATE TABLE "voip_sip_trunks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(20) DEFAULT 'other' NOT NULL,
	"auth_mode" varchar(20) NOT NULL,
	"ip_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sip_username" varchar(64),
	"transport" varchar(5) DEFAULT 'udp' NOT NULL,
	"provider_connection_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_inbound_at" timestamp,
	"last_error" text,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_problems" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"problem_number" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"priority" varchar(10),
	"root_cause" text,
	"workaround" text,
	"resolution" text,
	"assignee_id" varchar(255),
	"department_id" varchar(30),
	"article_id" varchar(30),
	"known_error_at" timestamp,
	"resolved_at" timestamp,
	"closed_at" timestamp,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_catalog_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"summary" varchar(500),
	"description" text,
	"category" varchar(100),
	"icon" varchar(50),
	"ticket_type_id" varchar(30) NOT NULL,
	"department_id" varchar(30),
	"priority" varchar(10),
	"delivery_estimate" varchar(100),
	"approval_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fulfilment_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience_company_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_request_approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"catalog_item_id" varchar(30) NOT NULL,
	"step_index" integer NOT NULL,
	"step_name" varchar(255),
	"approver_id" varchar(255),
	"status" varchar(10) DEFAULT 'waiting' NOT NULL,
	"decided_at" timestamp,
	"decided_by_id" varchar(255),
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "asset_sources" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"type" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"object_slug" varchar(64) DEFAULT 'asset' NOT NULL,
	"config" jsonb NOT NULL,
	"secret_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_hours" integer DEFAULT 24 NOT NULL,
	"next_sync_at" timestamp,
	"sync_state" jsonb,
	"last_sync_at" timestamp,
	"last_status" varchar(10),
	"last_error" text,
	"last_stats" jsonb,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "sip_trunk_id" varchar(30);--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "translation" jsonb;--> statement-breakpoint
ALTER TABLE "voip_phone_numbers" ADD COLUMN "sip_trunk_id" varchar(30);--> statement-breakpoint
ALTER TABLE "voip_phone_numbers" ADD COLUMN "caller_id_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "problem_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "catalog_item_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "approval_status" varchar(10);--> statement-breakpoint
CREATE UNIQUE INDEX "voip_sip_trunks_connection_uidx" ON "voip_sip_trunks" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX "voip_sip_trunks_status_idx" ON "voip_sip_trunks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_problems_number_uidx" ON "desk_problems" USING btree ("problem_number");--> statement-breakpoint
CREATE INDEX "desk_problems_status_idx" ON "desk_problems" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "desk_problems_assignee_idx" ON "desk_problems" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "desk_problems_known_error_idx" ON "desk_problems" USING btree ("known_error_at") WHERE "desk_problems"."known_error_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_catalog_items_active_idx" ON "desk_catalog_items" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "desk_catalog_items_type_idx" ON "desk_catalog_items" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "desk_request_approvals_conversation_idx" ON "desk_request_approvals" USING btree ("conversation_id","step_index");--> statement-breakpoint
CREATE INDEX "desk_request_approvals_approver_idx" ON "desk_request_approvals" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "asset_sources_due_idx" ON "asset_sources" USING btree ("enabled","next_sync_at");--> statement-breakpoint
CREATE INDEX "voip_phone_numbers_sip_trunk_idx" ON "voip_phone_numbers" USING btree ("sip_trunk_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_problem_idx" ON "desk_conversations" USING btree ("problem_id") WHERE "desk_conversations"."problem_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_conversations_catalog_item_idx" ON "desk_conversations" USING btree ("catalog_item_id") WHERE "desk_conversations"."catalog_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_conversations_approval_status_idx" ON "desk_conversations" USING btree ("approval_status") WHERE "desk_conversations"."approval_status" IS NOT NULL;