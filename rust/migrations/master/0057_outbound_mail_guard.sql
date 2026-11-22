CREATE TABLE "outbound_mail_cases" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255),
	"personal_account_id" varchar(30),
	"trigger" varchar(40) NOT NULL,
	"severity" varchar(10) NOT NULL,
	"fingerprint" varchar(32),
	"ai_verdict" jsonb,
	"risk_score" integer,
	"snippet" text,
	"subject" varchar(300),
	"sample_domains" jsonb,
	"sources" jsonb,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"alerted_at" timestamp,
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp,
	"review_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_mail_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255),
	"personal_account_id" varchar(30),
	"kind" varchar(40) NOT NULL,
	"from_value" varchar(40),
	"to_value" varchar(40),
	"reason" text,
	"actor" varchar(255) NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_mail_policies" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255),
	"personal_account_id" varchar(30),
	"trust_override" varchar(20),
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" varchar(20) DEFAULT 'active' NOT NULL,
	"state_reason" text,
	"state_set_by" varchar(255),
	"state_set_at" timestamp,
	"allow_replies_when_suspended" boolean DEFAULT false NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"risk_updated_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_mail_cases_dedupe_idx" ON "outbound_mail_cases" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbound_mail_cases_workspace_idx" ON "outbound_mail_cases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outbound_mail_cases_status_idx" ON "outbound_mail_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbound_mail_events_workspace_idx" ON "outbound_mail_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_mail_events_created_idx" ON "outbound_mail_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_mail_policies_workspace_idx" ON "outbound_mail_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_mail_policies_personal_idx" ON "outbound_mail_policies" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "outbound_mail_policies_state_idx" ON "outbound_mail_policies" USING btree ("state");--> statement-breakpoint
CREATE INDEX "outbound_mail_policies_risk_idx" ON "outbound_mail_policies" USING btree ("risk_score");