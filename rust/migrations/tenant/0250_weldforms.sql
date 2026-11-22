CREATE TABLE "form_access" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) DEFAULT 'results' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_ai_summaries" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"block_id" varchar(30),
	"response_count" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_folders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_integrations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_invitations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(255),
	"person_id" varchar(30),
	"user_id" varchar(255),
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"status" varchar(20) DEFAULT 'sent' NOT NULL,
	"subject" varchar(255),
	"message" text,
	"reminder_after_days" integer,
	"reminder_every_days" integer,
	"reminder_max_count" integer DEFAULT 0 NOT NULL,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"response_id" varchar(30),
	"invited_by_user_id" varchar(255) NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone,
	"next_reminder_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_response_actions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"response_id" varchar(30) NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"integration_id" varchar(30) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(30),
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_response_files" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"response_id" varchar(30) NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"block_id" varchar(30) NOT NULL,
	"kind" varchar(20) DEFAULT 'upload' NOT NULL,
	"storage_key" varchar(1000) NOT NULL,
	"name" varchar(255) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"version_id" varchar(30) NOT NULL,
	"number" integer,
	"status" varchar(20) DEFAULT 'in_progress' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hidden" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ending_id" varchar(30),
	"score" double precision,
	"respondent_email" varchar(320),
	"respondent_user_id" varchar(255),
	"respondent_hash" varchar(64),
	"person_id" varchar(30),
	"invitation_id" varchar(30),
	"last_block_id" varchar(30),
	"answered_count" integer DEFAULT 0 NOT NULL,
	"search_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"duration_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"default_theme_id" varchar(30),
	"sender_name" varchar(255),
	"reminder_after_days" integer,
	"reminder_every_days" integer,
	"reminder_max_count" integer DEFAULT 3 NOT NULL,
	"show_badge" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_subscriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"mode" varchar(20) DEFAULT 'instant' NOT NULL,
	"last_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_themes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"tokens" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"number" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"theme" jsonb,
	"published_by_user_id" varchar(255) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"folder_id" varchar(30),
	"title" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"theme_id" varchar(30),
	"public_id" varchar(20),
	"published_version_id" varchar(30),
	"has_unpublished_changes" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"access" varchar(20) DEFAULT 'workspace' NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"response_count" integer DEFAULT 0 NOT NULL,
	"response_counter" integer DEFAULT 0 NOT NULL,
	"last_response_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "form_access_form_user_idx" ON "form_access" USING btree ("form_id","user_id");--> statement-breakpoint
CREATE INDEX "form_access_user_idx" ON "form_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "form_ai_summaries_form_idx" ON "form_ai_summaries" USING btree ("form_id","block_id");--> statement-breakpoint
CREATE INDEX "form_folders_position_idx" ON "form_folders" USING btree ("position");--> statement-breakpoint
CREATE INDEX "form_integrations_form_idx" ON "form_integrations" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "form_invitations_form_status_idx" ON "form_invitations" USING btree ("form_id","status");--> statement-breakpoint
CREATE INDEX "form_invitations_email_idx" ON "form_invitations" USING btree ("form_id","email");--> statement-breakpoint
CREATE INDEX "form_invitations_next_reminder_idx" ON "form_invitations" USING btree ("next_reminder_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_response_actions_response_integration_idx" ON "form_response_actions" USING btree ("response_id","integration_id");--> statement-breakpoint
CREATE INDEX "form_response_files_response_idx" ON "form_response_files" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "form_responses_form_status_idx" ON "form_responses" USING btree ("form_id","status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_form_number_idx" ON "form_responses" USING btree ("form_id","number");--> statement-breakpoint
CREATE INDEX "form_responses_email_idx" ON "form_responses" USING btree ("respondent_email");--> statement-breakpoint
CREATE INDEX "form_responses_user_idx" ON "form_responses" USING btree ("respondent_user_id");--> statement-breakpoint
CREATE INDEX "form_responses_hash_idx" ON "form_responses" USING btree ("form_id","respondent_hash");--> statement-breakpoint
CREATE INDEX "form_responses_person_idx" ON "form_responses" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "form_responses_invitation_idx" ON "form_responses" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "form_responses_submitted_at_idx" ON "form_responses" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_subscriptions_form_user_idx" ON "form_subscriptions" USING btree ("form_id","user_id");--> statement-breakpoint
CREATE INDEX "form_subscriptions_user_idx" ON "form_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_number_idx" ON "form_versions" USING btree ("form_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_public_id_idx" ON "forms" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "forms_folder_idx" ON "forms" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "forms_owner_idx" ON "forms" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "forms_status_idx" ON "forms" USING btree ("status");