CREATE TABLE "reach_warmup_mailboxes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"tenant_mailbox_id" varchar(30) NOT NULL,
	"email" varchar(320) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"mailbox_type" varchar(20) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Europe/Amsterdam' NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"started_at" timestamp with time zone,
	"ramp_day" integer DEFAULT 0 NOT NULL,
	"ramp_updated_at" timestamp with time zone,
	"daily_target" integer DEFAULT 0 NOT NULL,
	"planned_for" varchar(10),
	"smtp_credentials" text NOT NULL,
	"imap_credentials" text NOT NULL,
	"stats" jsonb,
	"paused_reason" varchar(100),
	"last_login_error" text,
	"last_login_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_warmup_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"thread_id" varchar(30) NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"from_mailbox_id" varchar(30) NOT NULL,
	"to_mailbox_id" varchar(30) NOT NULL,
	"corpus_thread_id" varchar(60) NOT NULL,
	"message_id_header" varchar(255) NOT NULL,
	"in_reply_to" varchar(255),
	"references" text,
	"subject" varchar(300) NOT NULL,
	"status" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"engage_at" timestamp with time zone,
	"engage_attempts" integer DEFAULT 0 NOT NULL,
	"engaged_at" timestamp with time zone,
	"placement" varchar(10),
	"actions" jsonb,
	"cleaned_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reach_warmup_mailboxes_tenant_idx" ON "reach_warmup_mailboxes" USING btree ("clerk_org_id","tenant_mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_warmup_mailboxes_email_idx" ON "reach_warmup_mailboxes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "reach_warmup_mailboxes_status_idx" ON "reach_warmup_mailboxes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reach_warmup_mailboxes_workspace_idx" ON "reach_warmup_mailboxes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reach_warmup_mailboxes_domain_idx" ON "reach_warmup_mailboxes" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_warmup_messages_message_id_idx" ON "reach_warmup_messages" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "reach_warmup_messages_send_due_idx" ON "reach_warmup_messages" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "reach_warmup_messages_engage_due_idx" ON "reach_warmup_messages" USING btree ("status","engage_at");--> statement-breakpoint
CREATE INDEX "reach_warmup_messages_from_idx" ON "reach_warmup_messages" USING btree ("from_mailbox_id","sent_at");--> statement-breakpoint
CREATE INDEX "reach_warmup_messages_to_idx" ON "reach_warmup_messages" USING btree ("to_mailbox_id","sent_at");--> statement-breakpoint
CREATE INDEX "reach_warmup_messages_thread_idx" ON "reach_warmup_messages" USING btree ("thread_id");