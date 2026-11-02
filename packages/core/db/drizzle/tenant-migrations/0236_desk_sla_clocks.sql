CREATE TABLE "desk_sla_clocks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"metric" varchar(20) NOT NULL,
	"policy_id" varchar(30),
	"target_minutes" integer NOT NULL,
	"warn_before_minutes" integer,
	"calendar" jsonb,
	"status" varchar(10) NOT NULL,
	"started_at" timestamp NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp,
	"warn_at" timestamp,
	"breached_at" timestamp,
	"completed_at" timestamp,
	"warned_at" timestamp,
	"breach_notified_at" timestamp,
	"next_check_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "sla_policy_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "sla_status" varchar(10);--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "sla_due_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "sla_metric" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX "desk_sla_clocks_conversation_metric_uidx" ON "desk_sla_clocks" USING btree ("conversation_id","metric");--> statement-breakpoint
CREATE INDEX "desk_sla_clocks_next_check_idx" ON "desk_sla_clocks" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "desk_conversations_state_sla_due_idx" ON "desk_conversations" USING btree ("state","sla_due_at");