CREATE TYPE "public"."personal_mail_provider" AS ENUM('weldmail', 'gmail', 'outlook', 'imap', 'smtp', 'custom');
--> statement-breakpoint
CREATE TYPE "public"."personal_mail_account_status" AS ENUM('active', 'inactive', 'error', 'suspended');
--> statement-breakpoint
CREATE TYPE "public"."personal_mail_priority" AS ENUM('highest', 'high', 'normal', 'low', 'lowest');
--> statement-breakpoint
CREATE TYPE "public"."personal_mail_security_status" AS ENUM('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror');
--> statement-breakpoint
CREATE TABLE "personal_mail_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"provider" "personal_mail_provider" DEFAULT 'weldmail' NOT NULL,
	"status" "personal_mail_account_status" DEFAULT 'active' NOT NULL,
	"signature" text,
	"ai_settings" jsonb,
	"daily_send_limit" integer,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "personal_mail_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"message_id" varchar(500) NOT NULL,
	"thread_id" varchar(255),
	"from" jsonb NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb,
	"bcc" jsonb,
	"reply_to" jsonb,
	"subject" varchar(998),
	"preview" varchar(500),
	"text_body" text,
	"html_body" text,
	"raw_message" text,
	"sent_date" timestamp NOT NULL,
	"received_date" timestamp,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false,
	"is_draft" boolean DEFAULT false,
	"is_spam" boolean DEFAULT false,
	"is_trash" boolean DEFAULT false,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachment_count" integer DEFAULT 0,
	"in_reply_to" varchar(500),
	"references" jsonb,
	"is_reply" boolean DEFAULT false,
	"labels" jsonb,
	"priority" "personal_mail_priority" DEFAULT 'normal',
	"spf_status" "personal_mail_security_status",
	"dkim_status" "personal_mail_security_status",
	"dmarc_status" "personal_mail_security_status",
	"send_status" varchar(20),
	"send_provider" varchar(50),
	"provider_message_id" varchar(255),
	"source" varchar(20),
	"idempotency_key" varchar(64),
	"headers" jsonb,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "personal_mail_labels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7),
	"is_system" boolean DEFAULT false,
	"slug" varchar(50),
	"message_count" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0,
	"ai_description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "personal_mail_drafts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"subject" varchar(998),
	"to" jsonb,
	"cc" jsonb,
	"bcc" jsonb,
	"reply_to" jsonb,
	"body" text,
	"html_body" text,
	"importance" varchar(20) DEFAULT 'normal',
	"labels" jsonb,
	"has_attachments" boolean DEFAULT false,
	"attachment_count" integer DEFAULT 0,
	"attachment_ids" jsonb,
	"in_reply_to" varchar(500),
	"original_message_id" varchar(30),
	"is_reply" boolean DEFAULT false,
	"is_forward" boolean DEFAULT false,
	"last_auto_saved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "personal_mail_attachments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"message_id" varchar(30) NOT NULL,
	"file_name" varchar(500) NOT NULL,
	"content_type" varchar(255),
	"size" integer DEFAULT 0 NOT NULL,
	"is_inline" boolean DEFAULT false,
	"content_id" varchar(255),
	"content_disposition" varchar(100),
	"checksum" varchar(64),
	"download_url" text,
	"storage_path" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "personal_mail_messages" ADD CONSTRAINT "personal_mail_messages_account_id_personal_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_mail_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "personal_mail_labels" ADD CONSTRAINT "personal_mail_labels_account_id_personal_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_mail_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "personal_mail_drafts" ADD CONSTRAINT "personal_mail_drafts_account_id_personal_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_mail_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "personal_mail_attachments" ADD CONSTRAINT "personal_mail_attachments_message_id_personal_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."personal_mail_messages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "personal_mail_accounts_personal_account_id_idx" ON "personal_mail_accounts" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mail_accounts_email_idx" ON "personal_mail_accounts" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "personal_mail_accounts_status_idx" ON "personal_mail_accounts" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "personal_mail_messages_personal_account_id_idx" ON "personal_mail_messages" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_messages_account_id_idx" ON "personal_mail_messages" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_messages_thread_id_idx" ON "personal_mail_messages" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_messages_sent_date_idx" ON "personal_mail_messages" USING btree ("sent_date");
--> statement-breakpoint
CREATE INDEX "personal_mail_messages_is_read_idx" ON "personal_mail_messages" USING btree ("is_read");
--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mail_messages_account_idempotency_idx" ON "personal_mail_messages" USING btree ("account_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "personal_mail_labels_personal_account_id_idx" ON "personal_mail_labels" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_labels_account_id_idx" ON "personal_mail_labels" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_drafts_personal_account_id_idx" ON "personal_mail_drafts" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_drafts_account_id_idx" ON "personal_mail_drafts" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_attachments_personal_account_id_idx" ON "personal_mail_attachments" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE INDEX "personal_mail_attachments_message_id_idx" ON "personal_mail_attachments" USING btree ("message_id");
