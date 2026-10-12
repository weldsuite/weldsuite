CREATE TABLE "reach_campaign_mailboxes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(30) NOT NULL,
	"mailbox_id" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_campaign_steps" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(30) NOT NULL,
	"order" integer NOT NULL,
	"delay_days" integer DEFAULT 3 NOT NULL,
	"delay_hours" integer DEFAULT 0 NOT NULL,
	"subject" varchar(300) NOT NULL,
	"body" text NOT NULL,
	"reply_in_thread" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_campaigns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Europe/Amsterdam' NOT NULL,
	"send_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"window_start" varchar(5) DEFAULT '09:00' NOT NULL,
	"window_end" varchar(5) DEFAULT '17:00' NOT NULL,
	"daily_limit" integer DEFAULT 100 NOT NULL,
	"min_gap_minutes" integer DEFAULT 8 NOT NULL,
	"stop_on_auto_reply" boolean DEFAULT false NOT NULL,
	"stats" jsonb DEFAULT '{"prospects":0,"sent":0,"replied":0,"interested":0,"bounced":0,"unsubscribed":0}'::jsonb NOT NULL,
	"paused_reason" text,
	"launched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_id" varchar(255),
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reach_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"host_domain_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"mailpool_domain_id" varchar(50),
	"status" varchar(20) DEFAULT 'connecting' NOT NULL,
	"dns_status" jsonb,
	"dmarc_policy" varchar(20),
	"forced_by" varchar(255),
	"connected_at" timestamp with time zone,
	"connected_by" varchar(255),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_enrollments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(30) NOT NULL,
	"prospect_id" varchar(30) NOT NULL,
	"mailbox_id" varchar(30),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_send_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_message_id" varchar(30),
	"thread_root_message_id" varchar(255),
	"stopped_reason" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_mailboxes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"domain_id" varchar(30) NOT NULL,
	"mailpool_mailbox_id" varchar(50),
	"email" varchar(320) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"signature" text,
	"type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"smtp_credentials" text,
	"imap_credentials" text,
	"inbound_token" varchar(40) NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"warmup_day" integer DEFAULT 0 NOT NULL,
	"warmup_status" varchar(30),
	"daily_cap" integer DEFAULT 30 NOT NULL,
	"ramp_current" integer DEFAULT 10 NOT NULL,
	"ramp_updated_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"paused_reason" text,
	"last_error" text,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reach_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"direction" varchar(3) NOT NULL,
	"campaign_id" varchar(30),
	"enrollment_id" varchar(30),
	"step_id" varchar(30),
	"mailbox_id" varchar(30) NOT NULL,
	"prospect_id" varchar(30),
	"thread_key" varchar(255),
	"message_id_header" varchar(255) NOT NULL,
	"in_reply_to" varchar(255),
	"references" text,
	"from_email" varchar(320) NOT NULL,
	"to_email" varchar(320) NOT NULL,
	"subject" varchar(500),
	"snippet" text,
	"body_text" text,
	"r2_key" text,
	"status" varchar(20),
	"smtp_response" text,
	"error" text,
	"kind" varchar(20),
	"label" varchar(30),
	"label_source" varchar(10),
	"classified_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"handled_by" varchar(255),
	"sent_by" varchar(255),
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_prospect_list_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"list_id" varchar(30) NOT NULL,
	"prospect_id" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_prospect_lists" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"source_ref" varchar(255),
	"prospect_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reach_prospects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"company_name" varchar(200),
	"company_domain" varchar(255),
	"title" varchar(200),
	"timezone" varchar(64),
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"source_ref" varchar(255),
	"person_id" varchar(30),
	"validation" varchar(20) DEFAULT 'valid' NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reach_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"sender_company_name" varchar(200),
	"sender_address" text,
	"opt_out_text" text,
	"default_timezone" varchar(64) DEFAULT 'Europe/Amsterdam' NOT NULL,
	"default_send_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"default_window_start" varchar(5) DEFAULT '09:00' NOT NULL,
	"default_window_end" varchar(5) DEFAULT '17:00' NOT NULL,
	"default_mailbox_daily_cap" integer DEFAULT 30 NOT NULL,
	"stop_on_reply_scope" varchar(20) DEFAULT 'prospect' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reach_suppressions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"value" varchar(320) NOT NULL,
	"type" varchar(10) DEFAULT 'email' NOT NULL,
	"reason" varchar(20) NOT NULL,
	"source" varchar(255),
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reach_campaign_mailboxes_unique_idx" ON "reach_campaign_mailboxes" USING btree ("campaign_id","mailbox_id");--> statement-breakpoint
CREATE INDEX "reach_campaign_mailboxes_mailbox_idx" ON "reach_campaign_mailboxes" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_campaign_steps_order_idx" ON "reach_campaign_steps" USING btree ("campaign_id","order");--> statement-breakpoint
CREATE INDEX "reach_campaigns_status_idx" ON "reach_campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_domains_host_domain_idx" ON "reach_domains" USING btree ("host_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_domains_name_idx" ON "reach_domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "reach_domains_mailpool_idx" ON "reach_domains" USING btree ("mailpool_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_enrollments_campaign_prospect_idx" ON "reach_enrollments" USING btree ("campaign_id","prospect_id");--> statement-breakpoint
CREATE INDEX "reach_enrollments_due_idx" ON "reach_enrollments" USING btree ("status","next_send_at");--> statement-breakpoint
CREATE INDEX "reach_enrollments_prospect_idx" ON "reach_enrollments" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "reach_enrollments_mailbox_idx" ON "reach_enrollments" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_mailboxes_email_idx" ON "reach_mailboxes" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_mailboxes_inbound_token_idx" ON "reach_mailboxes" USING btree ("inbound_token");--> statement-breakpoint
CREATE INDEX "reach_mailboxes_domain_idx" ON "reach_mailboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "reach_mailboxes_status_idx" ON "reach_mailboxes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reach_mailboxes_mailpool_idx" ON "reach_mailboxes" USING btree ("mailpool_mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_messages_message_id_idx" ON "reach_messages" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "reach_messages_thread_idx" ON "reach_messages" USING btree ("thread_key");--> statement-breakpoint
CREATE INDEX "reach_messages_mailbox_sent_idx" ON "reach_messages" USING btree ("mailbox_id","sent_at");--> statement-breakpoint
CREATE INDEX "reach_messages_enrollment_idx" ON "reach_messages" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "reach_messages_inbox_idx" ON "reach_messages" USING btree ("direction","received_at");--> statement-breakpoint
CREATE INDEX "reach_messages_campaign_idx" ON "reach_messages" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_prospect_list_members_unique_idx" ON "reach_prospect_list_members" USING btree ("list_id","prospect_id");--> statement-breakpoint
CREATE INDEX "reach_prospect_list_members_prospect_idx" ON "reach_prospect_list_members" USING btree ("prospect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_prospects_email_idx" ON "reach_prospects" USING btree ("email");--> statement-breakpoint
CREATE INDEX "reach_prospects_company_domain_idx" ON "reach_prospects" USING btree ("company_domain");--> statement-breakpoint
CREATE INDEX "reach_prospects_person_idx" ON "reach_prospects" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_suppressions_value_idx" ON "reach_suppressions" USING btree ("value");