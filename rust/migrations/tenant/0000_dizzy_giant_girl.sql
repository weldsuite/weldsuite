CREATE TYPE "public"."host_domain_registration_status" AS ENUM('pending_registration', 'registered', 'pending_transfer', 'transferred', 'pending_renewal', 'renewed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."host_domain_status" AS ENUM('active', 'pending', 'expired', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."host_dns_provider" AS ENUM('hetzner', 'cloudflare', 'route53', 'custom');--> statement-breakpoint
CREATE TYPE "public"."host_dns_zone_status" AS ENUM('active', 'pending', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."host_dns_record_status" AS ENUM('active', 'pending', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."host_dns_record_type" AS ENUM('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA');--> statement-breakpoint
CREATE TYPE "public"."host_email_forward_status" AS ENUM('active', 'pending', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."host_domain_transfer_status" AS ENUM('pending', 'pending_approval', 'approved', 'rejected', 'cancelled', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."host_domain_transfer_type" AS ENUM('incoming', 'outgoing');--> statement-breakpoint
CREATE TYPE "public"."mail_account_status" AS ENUM('active', 'inactive', 'error', 'suspended', 'quota_exceeded');--> statement-breakpoint
CREATE TYPE "public"."mail_auth_type" AS ENUM('oauth2', 'password', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."mail_provider" AS ENUM('gmail', 'outlook', 'office365', 'exchange', 'imap', 'yahoo', 'mailcow', 'custom');--> statement-breakpoint
CREATE TYPE "public"."mail_sync_status" AS ENUM('idle', 'syncing', 'completed', 'error', 'paused');--> statement-breakpoint
CREATE TYPE "public"."mail_domain_dns_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mail_folder_sync_status" AS ENUM('idle', 'syncing', 'completed', 'error', 'paused');--> statement-breakpoint
CREATE TYPE "public"."mail_folder_type" AS ENUM('inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'custom');--> statement-breakpoint
CREATE TYPE "public"."mail_priority" AS ENUM('highest', 'high', 'normal', 'low', 'lowest');--> statement-breakpoint
CREATE TYPE "public"."mail_security_status" AS ENUM('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror');--> statement-breakpoint
CREATE TYPE "public"."mail_template_type" AS ENUM('marketing', 'transactional', 'notification', 'newsletter', 'welcome', 'custom');--> statement-breakpoint
CREATE TYPE "public"."mail_campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mail_campaign_winner_criteria" AS ENUM('open_rate', 'click_rate');--> statement-breakpoint
CREATE TYPE "public"."mail_rule_match_type" AS ENUM('all', 'any');--> statement-breakpoint
CREATE TYPE "public"."mail_rule_scope" AS ENUM('incoming', 'outgoing', 'all');--> statement-breakpoint
CREATE TYPE "public"."mail_signature_position" AS ENUM('above', 'below');--> statement-breakpoint
CREATE TYPE "public"."mail_signature_type" AS ENUM('personal', 'company', 'department');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"deleted_at" timestamp,
	"administration_id" varchar(30),
	"code" varchar(50),
	"name" varchar(255) NOT NULL,
	"description" text,
	"customer_id" varchar(30),
	"project_manager_id" varchar(30),
	"status" varchar(50) DEFAULT 'Planning' NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"actual_start_date" timestamp,
	"actual_end_date" timestamp,
	"budgeted_hours" numeric(18, 2),
	"budgeted_amount" numeric(18, 2),
	"actual_hours" numeric(18, 2),
	"actual_amount" numeric(18, 2),
	"billing_method" varchar(50),
	"hourly_rate" numeric(18, 2),
	"is_billable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"track_time" boolean DEFAULT true NOT NULL,
	"key" varchar(50),
	"priority" varchar(50),
	"type" varchar(50),
	"health" varchar(50),
	"progress" numeric(5, 2) DEFAULT '0' NOT NULL,
	"methodology" varchar(50),
	"visibility" varchar(50),
	"leader_id" varchar(255),
	"client_id" varchar(255),
	"budget_currency" varchar(10),
	"total_tasks" integer DEFAULT 0 NOT NULL,
	"completed_tasks" integer DEFAULT 0 NOT NULL,
	"open_tasks" integer DEFAULT 0 NOT NULL,
	"total_milestones" integer DEFAULT 0 NOT NULL,
	"completed_milestones" integer DEFAULT 0 NOT NULL,
	"category_id" varchar(255),
	"color" varchar(50),
	"icon" varchar(255),
	"cover_image" varchar(500),
	"settings" jsonb,
	"whiteboard_data" text,
	"document_data" text,
	"goals_data" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"sprint_id" varchar(255),
	"milestone_id" varchar(255),
	"parent_task_id" varchar(255),
	"title" varchar(500) NOT NULL,
	"description" text,
	"key" varchar(50),
	"status" varchar(50) DEFAULT 'todo' NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"progress" numeric(5, 2) DEFAULT '0' NOT NULL,
	"type" varchar(50) DEFAULT 'task',
	"category" varchar(100),
	"tags" jsonb,
	"labels" jsonb,
	"assignee_id" varchar(255),
	"reporter_id" varchar(255),
	"watchers" jsonb,
	"start_date" timestamp,
	"due_date" timestamp,
	"completed_date" timestamp,
	"estimated_hours" numeric(10, 2),
	"actual_hours" numeric(10, 2),
	"story_points" integer,
	"depends_on" jsonb,
	"blocks" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"board_position" integer,
	"acceptance_criteria" text,
	"resolution" varchar(255),
	"is_billable" boolean DEFAULT true NOT NULL,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255),
	"task_id" varchar(255),
	"user_id" varchar(255) NOT NULL,
	"date" date NOT NULL,
	"start_time" timestamp,
	"end_time" timestamp,
	"duration" numeric(10, 2) NOT NULL,
	"description" text,
	"activity" varchar(100),
	"billable" boolean DEFAULT true NOT NULL,
	"rate" numeric(10, 2),
	"cost" numeric(10, 2),
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"location" varchar(255),
	"is_remote" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"permissions" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"allocation_percentage" numeric(5, 2),
	"hourly_rate" numeric(10, 2),
	"metadata" jsonb,
	CONSTRAINT "project_members_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"due_date" timestamp NOT NULL,
	"completed_at" timestamp,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"progress" numeric(5, 2) DEFAULT '0' NOT NULL,
	"completed_tasks" integer DEFAULT 0,
	"total_tasks" integer DEFAULT 0,
	"deliverables" jsonb,
	"depends_on" jsonb,
	"owner_id" varchar(255),
	"responsible" jsonb,
	"tags" jsonb,
	"is_key_milestone" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255),
	"file_name" varchar(500) NOT NULL,
	"original_name" varchar(500),
	"mime_type" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"storage_path" varchar(1000) NOT NULL,
	"file_key" varchar(1000),
	"bucket" varchar(255),
	"url" varchar(1000),
	"thumbnail_url" varchar(1000),
	"storage_provider" varchar(50) DEFAULT 'r2' NOT NULL,
	"uploaded_by_id" varchar(255),
	"file_type" varchar(50) DEFAULT 'file' NOT NULL,
	"is_folder" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "project_messages" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255),
	"conversation_id" varchar(255) NOT NULL,
	"sender_id" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"message_type" varchar(50) DEFAULT 'text' NOT NULL,
	"reply_to_id" varchar(255),
	"attachments" jsonb,
	"edited_at" timestamp,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_by" jsonb,
	"reactions" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"goal" text,
	"status" varchar(50) DEFAULT 'planned' NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"velocity" integer,
	"story_points_committed" integer,
	"story_points_completed" integer
);
--> statement-breakpoint
CREATE TABLE "project_whiteboards" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) DEFAULT 'Main Whiteboard' NOT NULL,
	"elements" jsonb,
	"app_state" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"last_edited_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"title" varchar(500) DEFAULT 'Untitled' NOT NULL,
	"content" text,
	"content_type" varchar(50) DEFAULT 'html' NOT NULL,
	"cover_image" varchar(1000),
	"icon" varchar(100),
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp,
	"last_edited_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "project_goals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"mission" jsonb,
	"goals" jsonb DEFAULT '[]'::jsonb,
	"last_edited_by" varchar(255),
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"triggers" jsonb,
	"steps" jsonb,
	"settings" jsonb,
	"created_by" varchar(255),
	"folder_id" varchar(255),
	"tags" jsonb,
	"execution_count" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"failure_count" integer DEFAULT 0,
	"average_execution_time" numeric(10, 2),
	"last_executed_at" timestamp,
	"template_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30) NOT NULL,
	"workflow_version" integer DEFAULT 1 NOT NULL,
	"workflow_name" varchar(255),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"triggered_by" varchar(255),
	"trigger_type" varchar(30),
	"trigger_id" varchar(30),
	"trigger_data" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration" integer,
	"current_step_id" varchar(50),
	"current_step_index" integer DEFAULT 0,
	"total_steps" integer DEFAULT 0,
	"output" jsonb,
	"error" jsonb,
	"execution_context" jsonb,
	"trigger_dev_run_id" varchar(255),
	"retry_count" integer DEFAULT 0,
	"parent_execution_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_steps" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"execution_id" varchar(30) NOT NULL,
	"step_id" varchar(50) NOT NULL,
	"step_name" varchar(255),
	"step_type" varchar(100),
	"step_index" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration" integer,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 0,
	"logs" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workflow_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(30) NOT NULL,
	"config" jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"total_runs" integer DEFAULT 0,
	"successful_runs" integer DEFAULT 0,
	"failed_runs" integer DEFAULT 0,
	"trigger_dev_schedule_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workflow_id" varchar(30) NOT NULL,
	"trigger_id" varchar(30),
	"name" varchar(255),
	"description" text,
	"cron_expression" varchar(100) NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"interval" varchar(50),
	"start_date" timestamp,
	"end_date" timestamp,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"last_run_status" varchar(20),
	"total_runs" integer DEFAULT 0,
	"successful_runs" integer DEFAULT 0,
	"failed_runs" integer DEFAULT 0,
	"trigger_dev_schedule_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "workflow_webhooks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workflow_id" varchar(30) NOT NULL,
	"trigger_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"description" text,
	"url" varchar(500),
	"external_url" text,
	"secret" varchar(255),
	"secret_hash" varchar(255),
	"validate_signature" boolean DEFAULT false,
	"signature_header" varchar(100) DEFAULT 'x-webhook-signature',
	"allowed_methods" jsonb DEFAULT '["POST"]'::jsonb,
	"headers" jsonb,
	"ip_whitelist" jsonb,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_called_at" timestamp,
	"last_call_status" varchar(20),
	"last_call_ip" varchar(50),
	"total_calls" integer DEFAULT 0,
	"successful_calls" integer DEFAULT 0,
	"failed_calls" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "workflow_variables" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workflow_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"description" text,
	"scope" varchar(20) DEFAULT 'workflow' NOT NULL,
	"type" varchar(20) DEFAULT 'string' NOT NULL,
	"value" jsonb,
	"default_value" jsonb,
	"is_secret" boolean DEFAULT false NOT NULL,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"encrypted_value" text,
	"category" varchar(100),
	"tags" jsonb,
	"modified_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "workflow_integrations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(50) NOT NULL,
	"category" varchar(50),
	"status" varchar(20) DEFAULT 'disconnected' NOT NULL,
	"credentials_id" varchar(30),
	"credentials" jsonb,
	"is_oauth" boolean DEFAULT false NOT NULL,
	"oauth_provider" varchar(50),
	"oauth_scopes" jsonb,
	"oauth_tokens" jsonb,
	"connected_at" timestamp,
	"connected_by" varchar(255),
	"last_sync_at" timestamp,
	"last_error" text,
	"last_error_at" timestamp,
	"settings" jsonb,
	"icon" varchar(255),
	"website" varchar(500),
	"documentation" varchar(500),
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"short_description" varchar(500),
	"category" varchar(50) NOT NULL,
	"triggers" jsonb,
	"steps" jsonb,
	"settings" jsonb,
	"configuration_schema" jsonb,
	"difficulty" varchar(20) DEFAULT 'beginner',
	"estimated_setup_time" integer,
	"tags" jsonb,
	"thumbnail" varchar(500),
	"icon" varchar(255),
	"color" varchar(20),
	"author_id" varchar(255),
	"author_name" varchar(255),
	"author_avatar" varchar(500),
	"is_official" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"published_at" timestamp,
	"usage_count" integer DEFAULT 0,
	"rating" numeric(3, 2),
	"rating_count" integer DEFAULT 0,
	"required_integrations" jsonb,
	"version" varchar(20) DEFAULT '1.0.0'
);
--> statement-breakpoint
CREATE TABLE "workflow_error_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30),
	"execution_id" varchar(30),
	"error_code" varchar(50),
	"error_message" text NOT NULL,
	"error_type" varchar(100),
	"severity" varchar(20) DEFAULT 'error' NOT NULL,
	"stack_trace" text,
	"step_id" varchar(50),
	"step_name" varchar(255),
	"step_type" varchar(100),
	"input" jsonb,
	"context" jsonb,
	"is_acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" varchar(255),
	"acknowledged_at" timestamp,
	"acknowledged_note" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_storage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"quota_bytes" bigint DEFAULT 10737418240 NOT NULL,
	"max_file_size" bigint DEFAULT 104857600 NOT NULL,
	"max_file_count" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_storage_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "pending_uploads" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"file_name" varchar(500) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"file_size" bigint NOT NULL,
	"file_key" varchar(1000) NOT NULL,
	"bucket" varchar(255) NOT NULL,
	"folder" varchar(255),
	"entity_type" varchar(100),
	"entity_id" varchar(255),
	"is_public" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(10) DEFAULT 'b2c' NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"full_name" varchar(255),
	"date_of_birth" timestamp,
	"gender" varchar(20),
	"company_name" varchar(255),
	"trading_name" varchar(255),
	"registration_number" varchar(100),
	"vat_number" varchar(50),
	"industry" varchar(100),
	"employee_count" varchar(50),
	"annual_revenue" jsonb,
	"website" varchar(500),
	"primary_contact_id" varchar(30),
	"email" varchar(255) NOT NULL,
	"alternate_emails" jsonb,
	"phone" varchar(50),
	"mobile" varchar(50),
	"fax" varchar(50),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"addresses" jsonb,
	"segment" varchar(50),
	"status" varchar(20) DEFAULT 'prospect' NOT NULL,
	"rating" varchar(10),
	"source" varchar(100),
	"owner_id" varchar(255),
	"territory_id" varchar(30),
	"account_manager_id" varchar(255),
	"parent_customer_id" varchar(30),
	"is_key_account" boolean DEFAULT false,
	"preferred_contact_method" varchar(20),
	"preferred_language" varchar(10),
	"timezone" varchar(50),
	"marketing_consent" boolean DEFAULT false,
	"email_opt_in" boolean DEFAULT false,
	"sms_opt_in" boolean DEFAULT false,
	"do_not_call" boolean DEFAULT false,
	"credit_limit" jsonb,
	"payment_terms" varchar(50),
	"tax_exempt" boolean DEFAULT false,
	"currency" varchar(3),
	"first_contact_date" timestamp,
	"last_contact_date" timestamp,
	"next_follow_up_date" timestamp,
	"contract_renewal_date" timestamp,
	"lifecycle_stage" varchar(30),
	"customer_since" timestamp,
	"churned_at" timestamp,
	"churn_reason" varchar(500),
	"lead_score" integer DEFAULT 0,
	"satisfaction_score" integer,
	"nps_score" integer,
	"total_opportunities" integer DEFAULT 0,
	"won_opportunities" integer DEFAULT 0,
	"total_revenue" jsonb,
	"lifetime_value" jsonb,
	"average_deal_size" jsonb,
	"total_orders" integer DEFAULT 0,
	"total_spent" jsonb,
	"linkedin_url" varchar(500),
	"twitter_handle" varchar(100),
	"facebook_url" varchar(500),
	"tags" jsonb,
	"custom_fields" jsonb,
	"notes" text,
	"internal_notes" text
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"customer_id" varchar(30) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"full_name" varchar(255),
	"title" varchar(100),
	"department" varchar(100),
	"email" varchar(255) NOT NULL,
	"direct_phone" varchar(50),
	"mobile_phone" varchar(50),
	"extension" varchar(20),
	"role" varchar(30),
	"is_primary" boolean DEFAULT false,
	"is_decision_maker" boolean DEFAULT false,
	"is_billing_contact" boolean DEFAULT false,
	"is_technical_contact" boolean DEFAULT false,
	"influence_level" varchar(10),
	"preferred_contact_method" varchar(20),
	"preferred_language" varchar(10),
	"best_time_to_contact" varchar(100),
	"email_opt_in" boolean DEFAULT false,
	"do_not_call" boolean DEFAULT false,
	"linkedin_url" varchar(500),
	"twitter_handle" varchar(100),
	"last_contacted_at" timestamp,
	"last_activity_type" varchar(50),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"notes" text,
	"interests" jsonb
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"sku" varchar(100),
	"barcode" varchar(100),
	"description" text,
	"short_description" varchar(500),
	"price" numeric(18, 2) DEFAULT '0' NOT NULL,
	"compare_at_price" numeric(18, 2),
	"cost_price" numeric(18, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"track_inventory" boolean DEFAULT true,
	"inventory_quantity" integer DEFAULT 0,
	"low_stock_threshold" integer DEFAULT 5,
	"allow_backorder" boolean DEFAULT false,
	"weight" numeric(10, 3),
	"weight_unit" varchar(10) DEFAULT 'kg',
	"length" numeric(10, 2),
	"width" numeric(10, 2),
	"height" numeric(10, 2),
	"dimension_unit" varchar(10) DEFAULT 'cm',
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(20) DEFAULT 'visible',
	"meta_title" varchar(255),
	"meta_description" varchar(500),
	"meta_keywords" jsonb,
	"images" jsonb,
	"featured_image_url" varchar(500),
	"product_type" varchar(100),
	"vendor" varchar(255),
	"brand" varchar(255),
	"taxable" boolean DEFAULT true,
	"tax_class" varchar(50),
	"requires_shipping" boolean DEFAULT true,
	"shipping_class" varchar(50),
	"has_variants" boolean DEFAULT false,
	"options" jsonb,
	"variant_count" integer DEFAULT 0,
	"tags" jsonb,
	"attributes" jsonb,
	"custom_fields" jsonb,
	"view_count" integer DEFAULT 0,
	"sales_count" integer DEFAULT 0,
	"rating" numeric(3, 2),
	"review_count" integer DEFAULT 0,
	"published_at" timestamp,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"parent_id" varchar(30),
	"path" varchar(500),
	"depth" integer DEFAULT 0,
	"position" integer DEFAULT 0,
	"image" varchar(500),
	"icon" varchar(100),
	"color" varchar(20),
	"meta_title" varchar(255),
	"meta_description" varchar(500),
	"is_active" integer DEFAULT 1,
	"product_count" integer DEFAULT 0,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "category_products" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"category_id" varchar(30) NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"position" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30),
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255) NOT NULL,
	"description" varchar(500),
	"image_url" varchar(500),
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT '0',
	"tax_amount" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) NOT NULL,
	"weight" numeric(10, 3),
	"fulfilled_quantity" integer DEFAULT 0,
	"requires_shipping" integer DEFAULT 1,
	"properties" jsonb
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"order_number" varchar(50) NOT NULL,
	"external_order_id" varchar(100),
	"customer_id" varchar(30),
	"customer_email" varchar(255),
	"customer_name" varchar(255),
	"customer_phone" varchar(50),
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"payment_status" varchar(30) DEFAULT 'pending',
	"fulfillment_status" varchar(30) DEFAULT 'unfulfilled',
	"currency" varchar(3) DEFAULT 'USD',
	"subtotal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(18, 2) DEFAULT '0',
	"shipping_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_lines" jsonb,
	"tax_exempt" integer DEFAULT 0,
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"shipping_method" varchar(100),
	"shipping_carrier" varchar(100),
	"tracking_number" varchar(255),
	"tracking_url" varchar(500),
	"shipped_at" timestamp,
	"delivered_at" timestamp,
	"payment_method" varchar(100),
	"payment_reference" varchar(255),
	"paid_at" timestamp,
	"discount_code" varchar(100),
	"discount_id" varchar(30),
	"customer_note" text,
	"internal_note" text,
	"item_count" integer DEFAULT 0,
	"total_quantity" integer DEFAULT 0,
	"source" varchar(50) DEFAULT 'web',
	"source_order_id" varchar(100),
	"cancelled_at" timestamp,
	"cancel_reason" varchar(500),
	"completed_at" timestamp,
	"metadata" jsonb,
	"tags" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "product_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"platform" varchar(50) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"external_product_id" varchar(255),
	"external_variant_ids" jsonb,
	"sync_status" varchar(30) DEFAULT 'pending',
	"last_synced_at" timestamp,
	"last_sync_error" varchar(500),
	"sync_inventory" integer DEFAULT 1,
	"sync_prices" integer DEFAULT 1,
	"sync_images" integer DEFAULT 1,
	"sync_description" integer DEFAULT 1,
	"external_url" varchar(500),
	"external_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "crm_pipeline_stages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"position" integer DEFAULT 0 NOT NULL,
	"probability" integer DEFAULT 0,
	"color" varchar(50),
	"pipeline" varchar(100) DEFAULT 'default',
	"is_default" boolean DEFAULT false,
	"is_won" boolean DEFAULT false,
	"is_lost" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"full_name" varchar(255),
	"company_name" varchar(255),
	"title" varchar(100),
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"mobile" varchar(50),
	"website" varchar(500),
	"address" jsonb,
	"source" varchar(50) DEFAULT 'other' NOT NULL,
	"channel" varchar(100),
	"campaign" varchar(255),
	"medium" varchar(100),
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"rating" varchar(10),
	"score" integer DEFAULT 0,
	"owner_id" varchar(255),
	"assigned_at" timestamp,
	"is_qualified" boolean DEFAULT false,
	"qualified_at" timestamp,
	"disqualified_reason" varchar(500),
	"product_interest" jsonb,
	"budget" jsonb,
	"timeline" varchar(100),
	"authority" boolean,
	"need" text,
	"converted_at" timestamp,
	"converted_to_customer_id" varchar(30),
	"converted_to_opportunity_id" varchar(30),
	"first_response_at" timestamp,
	"last_activity_at" timestamp,
	"number_of_touches" integer DEFAULT 0,
	"notes" text,
	"next_action" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "crm_opportunities" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"customer_id" varchar(30) NOT NULL,
	"customer_name" varchar(255),
	"contact_ids" jsonb,
	"primary_contact_id" varchar(30),
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"expected_revenue" numeric(18, 2),
	"recurring_revenue" numeric(18, 2),
	"contract_length" integer,
	"stage_id" varchar(30),
	"stage" varchar(50) DEFAULT 'prospecting' NOT NULL,
	"probability" integer DEFAULT 0,
	"pipeline" varchar(100) DEFAULT 'default',
	"sales_process" varchar(100),
	"close_date" timestamp NOT NULL,
	"actual_close_date" timestamp,
	"start_date" timestamp,
	"competitors" jsonb,
	"competition_status" varchar(20),
	"win_loss_reason" varchar(500),
	"line_items" jsonb,
	"owner_id" varchar(255) NOT NULL,
	"team_members" jsonb,
	"lead_source" varchar(100),
	"campaign" varchar(255),
	"type" varchar(30),
	"category" varchar(100),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"forecast_category" varchar(20),
	"next_step" varchar(500),
	"next_step_date" timestamp,
	"risk_level" varchar(10),
	"risk_reason" varchar(500),
	"proposal_url" varchar(1000),
	"contract_url" varchar(1000),
	"attachments" jsonb,
	"last_activity_date" timestamp,
	"days_in_current_stage" integer DEFAULT 0,
	"total_activities" integer DEFAULT 0,
	"custom_fields" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(30) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"description" text,
	"related_to" varchar(20),
	"related_to_id" varchar(30),
	"related_to_name" varchar(255),
	"customer_id" varchar(30),
	"contact_id" varchar(30),
	"lead_id" varchar(30),
	"opportunity_id" varchar(30),
	"assigned_to_id" varchar(255) NOT NULL,
	"due_date" timestamp,
	"start_time" timestamp,
	"end_time" timestamp,
	"duration" integer,
	"status" varchar(20) DEFAULT 'planned' NOT NULL,
	"priority" varchar(10) DEFAULT 'medium',
	"location" varchar(500),
	"is_virtual" boolean DEFAULT false,
	"meeting_url" varchar(1000),
	"call_direction" varchar(10),
	"call_duration" integer,
	"call_recording_url" varchar(1000),
	"email_message_id" varchar(255),
	"email_subject" varchar(500),
	"email_from" varchar(255),
	"email_to" jsonb,
	"email_cc" jsonb,
	"attendees" jsonb,
	"meeting_agenda" text,
	"meeting_notes" text,
	"outcome" varchar(500),
	"next_action" varchar(500),
	"follow_up_date" timestamp,
	"attachments" jsonb,
	"tags" jsonb,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "crm_transcript_segments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"transcription_id" varchar(30) NOT NULL,
	"speaker_id" integer NOT NULL,
	"speaker_label" varchar(50),
	"speaker_name" varchar(255),
	"text" text NOT NULL,
	"start_time" real NOT NULL,
	"end_time" real NOT NULL,
	"timestamp" varchar(20),
	"confidence" real,
	"sequence_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_transcriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"activity_id" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"full_text" text,
	"model" varchar(100),
	"provider" varchar(50),
	"language" varchar(10) DEFAULT 'en',
	"speaker_count" integer,
	"word_count" integer,
	"confidence" real,
	"error_message" text,
	"processing_started_at" timestamp,
	"processing_completed_at" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "crm_quotes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"quote_number" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"customer_id" varchar(30) NOT NULL,
	"contact_id" varchar(30),
	"opportunity_id" varchar(30),
	"line_items" jsonb NOT NULL,
	"subtotal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 2),
	"tax" numeric(18, 2),
	"shipping" numeric(18, 2),
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"valid_from" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"payment_terms" varchar(255),
	"delivery_terms" varchar(255),
	"terms_and_conditions" text,
	"requires_approval" boolean DEFAULT false,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"signature_required" boolean DEFAULT false,
	"signed_by" varchar(255),
	"signed_at" timestamp,
	"signature_url" varchar(1000),
	"pdf_url" varchar(1000),
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"notes" text,
	"internal_notes" text
);
--> statement-breakpoint
CREATE TABLE "meeting_bot_instances" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"service_url" text NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"last_health_check" timestamp,
	"last_error" text,
	"current_session_id" varchar(30),
	"total_meetings_processed" integer DEFAULT 0,
	"total_recording_minutes" integer DEFAULT 0,
	"is_enabled" boolean DEFAULT true,
	"priority" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "meeting_bot_sessions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"meeting_url" text NOT NULL,
	"meeting_id" varchar(255),
	"platform" varchar(50) NOT NULL,
	"title" varchar(500),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"joined_at" timestamp,
	"left_at" timestamp,
	"duration" integer,
	"participant_count" integer,
	"enable_transcription" boolean DEFAULT false,
	"enable_diarization" boolean DEFAULT true,
	"language" varchar(10) DEFAULT 'en',
	"contact_id" varchar(30),
	"opportunity_id" varchar(30),
	"activity_id" varchar(30),
	"external_bot_instance_id" varchar(100),
	"external_session_id" varchar(255),
	"external_recording_id" varchar(255),
	"recording_storage_url" text,
	"recording_storage_key" varchar(500),
	"recording_file_size" integer,
	"recording_duration" integer
);
--> statement-breakpoint
CREATE TABLE "commerce_cart_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"cart_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255) NOT NULL,
	"image_url" varchar(500),
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"properties" jsonb
);
--> statement-breakpoint
CREATE TABLE "commerce_carts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" varchar(255),
	"customer_id" varchar(30),
	"customer_email" varchar(255),
	"currency" varchar(3) DEFAULT 'USD',
	"subtotal" numeric(18, 2) DEFAULT '0',
	"discount_total" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) DEFAULT '0',
	"item_count" integer DEFAULT 0,
	"discount_code" varchar(100),
	"discount_id" varchar(30),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"shipping_method" varchar(100),
	"status" varchar(20) DEFAULT 'active',
	"converted_order_id" varchar(30),
	"converted_at" timestamp,
	"abandoned_at" timestamp,
	"recovery_email_sent" integer DEFAULT 0,
	"recovery_email_sent_at" timestamp,
	"expires_at" timestamp,
	"metadata" jsonb,
	"source" varchar(50) DEFAULT 'web'
);
--> statement-breakpoint
CREATE TABLE "commerce_discount_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"discount_id" varchar(30) NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"customer_id" varchar(30),
	"discount_amount" numeric(18, 2) NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_discounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"description" text,
	"type" varchar(30) DEFAULT 'percentage' NOT NULL,
	"value" numeric(18, 2) NOT NULL,
	"applies_to" varchar(30) DEFAULT 'all',
	"product_ids" jsonb,
	"category_ids" jsonb,
	"customer_ids" jsonb,
	"minimum_order_amount" numeric(18, 2),
	"minimum_quantity" integer,
	"maximum_discount_amount" numeric(18, 2),
	"usage_limit" integer,
	"usage_limit_per_customer" integer,
	"used_count" integer DEFAULT 0,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"is_active" integer DEFAULT 1,
	"status" varchar(20) DEFAULT 'active',
	"combines_with" jsonb,
	"metadata" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "commerce_websites" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"template" varchar(100),
	"template_version" varchar(20),
	"status" varchar(20) DEFAULT 'draft',
	"published_at" timestamp,
	"unpublished_at" timestamp,
	"meta_title" varchar(255),
	"meta_description" varchar(500),
	"meta_keywords" jsonb,
	"favicon" varchar(500),
	"og_image" varchar(500),
	"logo" varchar(500),
	"logo_alt" varchar(500),
	"primary_color" varchar(20),
	"secondary_color" varchar(20),
	"accent_color" varchar(20),
	"heading_font" varchar(100),
	"body_font" varchar(100),
	"header_layout" varchar(50),
	"footer_layout" varchar(50),
	"google_analytics_id" varchar(50),
	"facebook_pixel_id" varchar(50),
	"custom_head_scripts" text,
	"custom_body_scripts" text,
	"social_links" jsonb,
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"contact_address" jsonb,
	"settings" jsonb,
	"page_count" integer DEFAULT 0,
	"created_by" varchar(255),
	"last_published_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "commerce_website_pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"website_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"path" varchar(500) NOT NULL,
	"page_type" varchar(30) DEFAULT 'page',
	"is_home_page" integer DEFAULT 0,
	"content" text,
	"content_type" varchar(20) DEFAULT 'sections',
	"meta_title" varchar(255),
	"meta_description" varchar(500),
	"meta_keywords" jsonb,
	"canonical_url" varchar(500),
	"og_image" varchar(500),
	"no_index" integer DEFAULT 0,
	"no_follow" integer DEFAULT 0,
	"layout" varchar(50) DEFAULT 'default',
	"show_header" integer DEFAULT 1,
	"show_footer" integer DEFAULT 1,
	"custom_css" text,
	"position" integer DEFAULT 0,
	"show_in_nav" integer DEFAULT 1,
	"nav_label" varchar(100),
	"parent_page_id" varchar(30),
	"status" varchar(20) DEFAULT 'draft',
	"published_at" timestamp,
	"scheduled_at" timestamp,
	"section_count" integer DEFAULT 0,
	"password_protected" integer DEFAULT 0,
	"password_hash" varchar(255),
	"metadata" jsonb,
	"created_by" varchar(255),
	"last_edited_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "commerce_website_sections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"website_id" varchar(30) NOT NULL,
	"page_id" varchar(30) NOT NULL,
	"type" varchar(50) NOT NULL,
	"name" varchar(255),
	"position" integer DEFAULT 0,
	"content" jsonb NOT NULL,
	"settings" jsonb,
	"is_visible" integer DEFAULT 1,
	"visible_on_mobile" integer DEFAULT 1,
	"visible_on_desktop" integer DEFAULT 1,
	"mobile_settings" jsonb,
	"tablet_settings" jsonb,
	"background_color" varchar(50),
	"background_image" varchar(500),
	"background_video" varchar(500),
	"custom_classes" varchar(500),
	"custom_styles" jsonb,
	"padding_top" varchar(20),
	"padding_bottom" varchar(20),
	"margin_top" varchar(20),
	"margin_bottom" varchar(20),
	"animation" varchar(50),
	"animation_delay" integer,
	"container_width" varchar(20) DEFAULT 'default',
	"anchor_id" varchar(100),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "commerce_website_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"website_id" varchar(30) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"subdomain" varchar(100),
	"root_domain" varchar(255),
	"domain_type" varchar(20) DEFAULT 'custom',
	"is_primary" integer DEFAULT 0,
	"is_verified" integer DEFAULT 0,
	"is_active" integer DEFAULT 0,
	"verification_method" varchar(20),
	"verification_token" varchar(255),
	"verified_at" timestamp,
	"last_verification_attempt" timestamp,
	"verification_error" varchar(500),
	"dns_config" jsonb,
	"dns_status" varchar(20) DEFAULT 'pending',
	"dns_records" jsonb,
	"last_dns_check" timestamp,
	"ssl_status" varchar(20) DEFAULT 'pending',
	"ssl_provider" varchar(50) DEFAULT 'letsencrypt',
	"ssl_expires_at" timestamp,
	"ssl_provisioned_at" timestamp,
	"redirect_to_primary" integer DEFAULT 0,
	"force_https" integer DEFAULT 1,
	"redirect_www" varchar(20),
	"cdn_enabled" integer DEFAULT 1,
	"edge_location_id" varchar(50),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"tld" varchar(50) NOT NULL,
	"full_domain" varchar(255) NOT NULL,
	"status" "host_domain_status" DEFAULT 'pending' NOT NULL,
	"registration_status" "host_domain_registration_status",
	"registrar" varchar(255),
	"external_registrar_id" varchar(255),
	"registrar_status" varchar(100),
	"registrar_synced_at" timestamp,
	"registered_at" timestamp,
	"expires_at" timestamp,
	"renewed_at" timestamp,
	"nameservers" jsonb,
	"custom_nameservers" boolean DEFAULT false,
	"nameserver_verified" boolean DEFAULT false,
	"nameserver_verification_pending" boolean DEFAULT false,
	"nameserver_verification_token" varchar(255),
	"auto_renew" boolean DEFAULT true,
	"privacy_protection" boolean DEFAULT false,
	"locked" boolean DEFAULT true,
	"ssl_enabled" boolean DEFAULT false,
	"email_forwarding_enabled" boolean DEFAULT false,
	"auth_code" varchar(255),
	"auth_code_expires_at" timestamp,
	"registrant_contact" jsonb,
	"admin_contact" jsonb,
	"tech_contact" jsonb,
	"billing_contact" jsonb,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dns_zones" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"domain_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "host_dns_zone_status" DEFAULT 'pending' NOT NULL,
	"provider" "host_dns_provider" DEFAULT 'hetzner' NOT NULL,
	"external_zone_id" varchar(255),
	"external_nameservers" jsonb,
	"synced_at" timestamp,
	"sync_error" varchar(1000),
	"dnssec_enabled" boolean DEFAULT false,
	"dnssec_keys" jsonb,
	"default_ttl" integer DEFAULT 3600,
	"refresh_interval" integer DEFAULT 86400,
	"retry_interval" integer DEFAULT 7200,
	"expire_time" integer DEFAULT 3600000,
	"minimum_ttl" integer DEFAULT 3600,
	"record_count" integer DEFAULT 0,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"zone_id" varchar(30) NOT NULL,
	"external_record_id" varchar(255),
	"type" "host_dns_record_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"ttl" integer DEFAULT 3600 NOT NULL,
	"priority" integer,
	"weight" integer,
	"port" integer,
	"caa_flag" integer,
	"caa_tag" varchar(50),
	"status" "host_dns_record_status" DEFAULT 'active' NOT NULL,
	"sync_error" varchar(1000),
	"synced_at" timestamp,
	"comment" varchar(500),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_forwards" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"domain_id" varchar(30) NOT NULL,
	"source" varchar(255) NOT NULL,
	"destination" varchar(500) NOT NULL,
	"additional_destinations" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"catch_all" boolean DEFAULT false,
	"wildcard" boolean DEFAULT false,
	"status" "host_email_forward_status" DEFAULT 'active' NOT NULL,
	"last_forwarded_at" timestamp,
	"forward_count" jsonb DEFAULT '0'::jsonb,
	"last_error" varchar(1000),
	"last_error_at" timestamp,
	"error_count" jsonb DEFAULT '0'::jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "domain_transfers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"domain_id" varchar(30),
	"domain_name" varchar(255) NOT NULL,
	"type" "host_domain_transfer_type" NOT NULL,
	"status" "host_domain_transfer_status" DEFAULT 'pending' NOT NULL,
	"auth_code" varchar(255),
	"from_registrar" varchar(255),
	"to_registrar" varchar(255),
	"external_transfer_id" varchar(255),
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"cancelled_at" timestamp,
	"completed_at" timestamp,
	"expires_at" timestamp,
	"rejection_reason" text,
	"cancellation_reason" text,
	"failure_reason" text,
	"notifications_sent" jsonb,
	"registrar_response" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"provider" "mail_provider" DEFAULT 'mailcow' NOT NULL,
	"provider_config" jsonb,
	"auth_type" "mail_auth_type" DEFAULT 'password' NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"api_key" text,
	"password_hash" text,
	"imap_host" varchar(255),
	"imap_port" integer,
	"imap_secure" boolean DEFAULT true,
	"smtp_host" varchar(255),
	"smtp_port" integer,
	"smtp_secure" boolean DEFAULT true,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"sync_frequency" integer DEFAULT 5,
	"last_sync_at" timestamp,
	"sync_status" "mail_sync_status" DEFAULT 'idle',
	"sync_error" text,
	"signature" text,
	"auto_reply" jsonb,
	"forwarding_email" varchar(255),
	"daily_send_limit" integer DEFAULT 500,
	"sent_today" integer DEFAULT 0,
	"storage_used" integer DEFAULT 0,
	"storage_limit" integer,
	"status" "mail_account_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false,
	"is_shared" boolean DEFAULT false,
	"external_account_id" varchar(255),
	"mailcow_synced_at" timestamp,
	"tags" jsonb,
	"custom_fields" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"domain_name" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false,
	"mail_provider" varchar(100) DEFAULT 'mailcow',
	"max_email_accounts" integer DEFAULT 10,
	"current_email_accounts" integer DEFAULT 0,
	"dns_status" "mail_domain_dns_status" DEFAULT 'pending',
	"dns_records" jsonb,
	"verified_at" timestamp,
	"last_verification_attempt" timestamp,
	"spf_verified" boolean DEFAULT false,
	"dkim_verified" boolean DEFAULT false,
	"dmarc_verified" boolean DEFAULT false,
	"dkim_selector" varchar(100),
	"dkim_public_key" text,
	"external_domain_id" varchar(255),
	"mailcow_domain_id" varchar(255),
	"mailcow_synced_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_folders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "mail_folder_type" DEFAULT 'custom' NOT NULL,
	"parent_id" varchar(30),
	"path" varchar(1000),
	"total_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"unseen_count" integer DEFAULT 0,
	"last_sync_at" timestamp,
	"sync_status" "mail_folder_sync_status" DEFAULT 'idle',
	"uid_validity" integer,
	"uid_next" integer,
	"is_selectable" boolean DEFAULT true NOT NULL,
	"is_subscribed" boolean DEFAULT true,
	"color" varchar(7),
	"icon" varchar(50),
	"position" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false,
	"special_use" jsonb,
	"external_folder_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"folder_id" varchar(30) NOT NULL,
	"message_id" varchar(500) NOT NULL,
	"thread_id" varchar(255),
	"conversation_id" varchar(255),
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
	"is_flagged" boolean DEFAULT false,
	"is_important" boolean DEFAULT false,
	"is_draft" boolean DEFAULT false,
	"is_spam" boolean DEFAULT false,
	"is_trash" boolean DEFAULT false,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachment_count" integer DEFAULT 0,
	"in_reply_to" varchar(500),
	"references" jsonb,
	"is_reply" boolean DEFAULT false,
	"is_forwarded" boolean DEFAULT false,
	"labels" jsonb,
	"categories" jsonb,
	"priority" "mail_priority" DEFAULT 'normal',
	"read_receipt" boolean DEFAULT false,
	"delivery_receipt" boolean DEFAULT false,
	"opened_at" timestamp,
	"clicked_links" jsonb,
	"is_encrypted" boolean DEFAULT false,
	"is_signed" boolean DEFAULT false,
	"spf_status" "mail_security_status",
	"dkim_status" "mail_security_status",
	"dmarc_status" "mail_security_status",
	"source" varchar(20),
	"external_message_id" varchar(255),
	"mailcow_message_id" varchar(255),
	"headers" jsonb,
	"custom_fields" jsonb,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
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
	"external_attachment_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_drafts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
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
CREATE TABLE "mail_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"subject" varchar(998) NOT NULL,
	"html_content" text NOT NULL,
	"text_content" text,
	"category" varchar(100),
	"description" text,
	"variables" jsonb,
	"required_variables" jsonb,
	"type" "mail_template_type" DEFAULT 'custom' NOT NULL,
	"purpose" varchar(255),
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false,
	"tags" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_campaigns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"template_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"subject" varchar(998) NOT NULL,
	"preheader" varchar(500),
	"html_content" text NOT NULL,
	"text_content" text,
	"recipient_list" jsonb NOT NULL,
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"segments" jsonb,
	"from_name" varchar(255) NOT NULL,
	"from_email" varchar(255) NOT NULL,
	"reply_to_email" varchar(255),
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"status" "mail_campaign_status" DEFAULT 'draft' NOT NULL,
	"sent_count" integer DEFAULT 0,
	"delivered_count" integer DEFAULT 0,
	"bounced_count" integer DEFAULT 0,
	"opened_count" integer DEFAULT 0,
	"clicked_count" integer DEFAULT 0,
	"unsubscribed_count" integer DEFAULT 0,
	"complaint_count" integer DEFAULT 0,
	"delivery_rate" real,
	"open_rate" real,
	"click_rate" real,
	"bounce_rate" real,
	"unsubscribe_rate" real,
	"is_ab_test" boolean DEFAULT false,
	"variants" jsonb,
	"winner_criteria" "mail_campaign_winner_criteria",
	"winner_variant_id" varchar(30),
	"track_opens" boolean DEFAULT true NOT NULL,
	"track_clicks" boolean DEFAULT true NOT NULL,
	"google_analytics" boolean DEFAULT false,
	"utm_parameters" jsonb,
	"tags" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"conditions" jsonb NOT NULL,
	"match_type" "mail_rule_match_type" DEFAULT 'all' NOT NULL,
	"actions" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stop_processing" boolean DEFAULT false,
	"priority" integer DEFAULT 0,
	"apply_to_existing" boolean DEFAULT false,
	"applied_count" integer DEFAULT 0,
	"last_applied_at" timestamp,
	"scope" "mail_rule_scope" DEFAULT 'incoming',
	"folders" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_signatures" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"account_ids" jsonb,
	"user_ids" jsonb,
	"type" "mail_signature_type" DEFAULT 'personal' NOT NULL,
	"include_in_replies" boolean DEFAULT true NOT NULL,
	"include_in_forwards" boolean DEFAULT true NOT NULL,
	"position" "mail_signature_position" DEFAULT 'below' NOT NULL,
	"tags" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_contacts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"company" varchar(255),
	"job_title" varchar(255),
	"phone" varchar(50),
	"avatar_url" text,
	"groups" jsonb,
	"emails_sent" integer DEFAULT 0,
	"emails_received" integer DEFAULT 0,
	"last_email_at" timestamp,
	"is_blocked" boolean DEFAULT false,
	"is_vip" boolean DEFAULT false,
	"is_bounced" boolean DEFAULT false,
	"is_unsubscribed" boolean DEFAULT false,
	"bounce_count" integer DEFAULT 0,
	"last_bounce_at" timestamp,
	"bounce_reason" varchar(500),
	"unsubscribed_at" timestamp,
	"unsubscribe_reason" varchar(500),
	"notes" text,
	"custom_fields" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mail_labels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7),
	"message_count" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "helpdesk_agents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"avatar" varchar(500),
	"role" varchar(30) DEFAULT 'agent' NOT NULL,
	"department_id" varchar(30),
	"team_ids" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"availability" varchar(20) DEFAULT 'offline',
	"is_online" boolean DEFAULT false,
	"last_seen_at" timestamp,
	"max_active_tickets" integer DEFAULT 10,
	"current_active_tickets" integer DEFAULT 0,
	"skills" jsonb,
	"languages" jsonb,
	"expertise" jsonb,
	"permissions" jsonb,
	"can_access_all_tickets" boolean DEFAULT false,
	"can_manage_knowledge" boolean DEFAULT false,
	"average_response_time" integer,
	"average_resolution_time" integer,
	"satisfaction_score" numeric(3, 2),
	"tickets_resolved" integer DEFAULT 0,
	"tickets_assigned" integer DEFAULT 0,
	"working_hours" jsonb,
	"timezone" varchar(50),
	"signature" text,
	"notification_preferences" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_departments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"email" varchar(255),
	"manager_id" varchar(30),
	"manager_name" varchar(255),
	"agent_ids" jsonb,
	"agent_count" integer DEFAULT 0,
	"auto_assignment" boolean DEFAULT false,
	"round_robin_assignment" boolean DEFAULT false,
	"escalation_rules" jsonb,
	"business_hours" jsonb,
	"categories" jsonb,
	"default_priority" varchar(20) DEFAULT 'medium',
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "helpdesk_conversations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"conversation_number" varchar(50) NOT NULL,
	"reference" varchar(100),
	"customer_id" varchar(30),
	"customer_name" varchar(255) NOT NULL,
	"customer_email" varchar(255) NOT NULL,
	"customer_phone" varchar(50),
	"customer_company" varchar(255),
	"customer_avatar" varchar(500),
	"subject" varchar(500) NOT NULL,
	"preview" text,
	"last_message" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"priority" varchar(20),
	"assignee_id" varchar(30),
	"assignee_name" varchar(255),
	"department_id" varchar(30),
	"channel" varchar(20) DEFAULT 'web' NOT NULL,
	"source" varchar(100),
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0,
	"last_message_at" timestamp,
	"last_customer_message_at" timestamp,
	"last_agent_message_at" timestamp,
	"ticket_id" varchar(30),
	"related_conversation_ids" jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_spam" boolean DEFAULT false,
	"tags" jsonb,
	"labels" jsonb,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachment_count" integer DEFAULT 0,
	"snoozed_until" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_conversation_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"conversation_id" varchar(30) NOT NULL,
	"author_id" varchar(255),
	"author_name" varchar(255) NOT NULL,
	"author_email" varchar(255),
	"author_type" varchar(20) DEFAULT 'customer' NOT NULL,
	"author_avatar" varchar(500),
	"content" text NOT NULL,
	"html_content" text,
	"plain_content" text,
	"type" varchar(20) DEFAULT 'message' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_internal" boolean DEFAULT false,
	"status" varchar(20) DEFAULT 'sent',
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"attachments" jsonb,
	"has_attachments" boolean DEFAULT false,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_tickets" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"ticket_number" varchar(50) NOT NULL,
	"reference" varchar(100),
	"customer_id" varchar(30),
	"customer_name" varchar(255) NOT NULL,
	"customer_email" varchar(255) NOT NULL,
	"customer_phone" varchar(50),
	"customer_company" varchar(255),
	"subject" varchar(500) NOT NULL,
	"description" text,
	"category" varchar(50) DEFAULT 'general_inquiry' NOT NULL,
	"subcategory" varchar(100),
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"severity" varchar(20),
	"assignee_id" varchar(30),
	"assignee_name" varchar(255),
	"department_id" varchar(30),
	"team_id" varchar(30),
	"channel" varchar(20) DEFAULT 'web' NOT NULL,
	"source_email" varchar(255),
	"source_url" varchar(500),
	"type" varchar(30) DEFAULT 'question' NOT NULL,
	"issue_type" varchar(50),
	"sla_id" varchar(30),
	"response_deadline" timestamp,
	"resolution_deadline" timestamp,
	"sla_status" varchar(20),
	"breached_at" timestamp,
	"first_response_at" timestamp,
	"resolved_at" timestamp,
	"closed_at" timestamp,
	"reopened_at" timestamp,
	"response_time" integer,
	"resolution_time" integer,
	"product_id" varchar(30),
	"product_name" varchar(255),
	"version" integer,
	"environment" varchar(50),
	"message_count" integer DEFAULT 0,
	"last_message_at" timestamp,
	"last_customer_message_at" timestamp,
	"last_agent_message_at" timestamp,
	"satisfaction_rating" integer,
	"satisfaction_comment" text,
	"satisfaction_survey_id" varchar(30),
	"tags" jsonb,
	"custom_fields" jsonb,
	"parent_ticket_id" varchar(30),
	"child_ticket_ids" jsonb,
	"related_ticket_ids" jsonb,
	"merged_ticket_ids" jsonb,
	"is_escalated" boolean DEFAULT false,
	"is_spam" boolean DEFAULT false,
	"is_public" boolean DEFAULT true,
	"requires_approval" boolean DEFAULT false,
	"attachments" jsonb,
	"attachment_count" integer DEFAULT 0,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_ticket_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"ticket_id" varchar(30) NOT NULL,
	"author_id" varchar(255),
	"author_name" varchar(255) NOT NULL,
	"author_email" varchar(255) NOT NULL,
	"author_type" varchar(20) DEFAULT 'customer' NOT NULL,
	"subject" varchar(500),
	"body" text NOT NULL,
	"html_body" text,
	"plain_body" text,
	"type" varchar(20) DEFAULT 'reply' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_internal" boolean DEFAULT false,
	"status" varchar(20) DEFAULT 'sent',
	"read_at" timestamp,
	"message_id" varchar(255),
	"in_reply_to" varchar(255),
	"cc" jsonb,
	"bcc" jsonb,
	"attachments" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_ticket_notes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"ticket_id" varchar(30) NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"is_important" boolean DEFAULT false,
	"attachments" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_article_folders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255),
	"description" text,
	"parent_id" varchar(30),
	"path" varchar(1000),
	"level" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"icon" varchar(100),
	"color" varchar(20),
	"article_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_articles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(500) NOT NULL,
	"slug" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"excerpt" text,
	"category" varchar(255),
	"category_id" varchar(30),
	"category_name" varchar(255),
	"subcategory_id" varchar(30),
	"section_id" varchar(30),
	"meta_title" varchar(255),
	"meta_description" text,
	"keywords" jsonb,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255),
	"reviewer_id" varchar(255),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(20) DEFAULT 'public' NOT NULL,
	"published_at" timestamp,
	"unpublished_at" timestamp,
	"scheduled_publish_at" timestamp,
	"version" integer DEFAULT 1,
	"is_draft" boolean DEFAULT true,
	"previous_version_id" varchar(30),
	"table_of_contents" text,
	"read_time" integer,
	"difficulty" varchar(20),
	"featured_image" varchar(500),
	"attachments" jsonb,
	"videos" jsonb,
	"view_count" integer DEFAULT 0,
	"like_count" integer DEFAULT 0,
	"dislike_count" integer DEFAULT 0,
	"helpful_count" integer DEFAULT 0,
	"not_helpful_count" integer DEFAULT 0,
	"related_articles" jsonb,
	"related_products" jsonb,
	"related_tickets" jsonb,
	"tags" jsonb,
	"custom_fields" jsonb,
	"is_pinned" boolean DEFAULT false,
	"allow_comments" boolean DEFAULT true,
	"requires_login" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "helpdesk_faqs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"category" varchar(100),
	"order" integer DEFAULT 0,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp,
	"view_count" integer DEFAULT 0,
	"helpful_count" integer DEFAULT 0,
	"not_helpful_count" integer DEFAULT 0,
	"related_faqs" jsonb,
	"related_articles" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_slas" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"conditions" jsonb,
	"is_default" boolean DEFAULT false,
	"first_response_time" jsonb,
	"resolution_time" jsonb,
	"update_time" jsonb,
	"operational_hours" varchar(20) DEFAULT 'business' NOT NULL,
	"business_hours" jsonb,
	"escalation_rules" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0,
	"reminders" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_canned_responses" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"subject" varchar(500),
	"content" text NOT NULL,
	"category" varchar(100),
	"scope" varchar(20) DEFAULT 'personal' NOT NULL,
	"agent_id" varchar(30),
	"team_id" varchar(30),
	"department_id" varchar(30),
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"shortcut" varchar(50),
	"keywords" jsonb,
	"actions" jsonb,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_contacts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"company" varchar(255),
	"role" varchar(100),
	"avatar" varchar(500),
	"tags" jsonb,
	"custom_fields" jsonb,
	"total_tickets" integer DEFAULT 0,
	"last_contact_date" timestamp
);
--> statement-breakpoint
CREATE TABLE "helpdesk_announcements" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"excerpt" text,
	"type" varchar(20) DEFAULT 'info' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(20) DEFAULT 'public' NOT NULL,
	"target_groups" jsonb,
	"featured_image" varchar(500),
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255),
	"published_at" timestamp,
	"expires_at" timestamp,
	"is_pinned" boolean DEFAULT false,
	"view_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "helpdesk_changelog" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"version" varchar(50) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text NOT NULL,
	"release_date" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"type" varchar(20) DEFAULT 'feature' NOT NULL,
	"changes" jsonb,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "helpdesk_news" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"excerpt" text,
	"category" varchar(100),
	"tags" jsonb,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"featured_image" varchar(500),
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255),
	"published_at" timestamp,
	"view_count" integer DEFAULT 0,
	"like_count" integer DEFAULT 0,
	"comment_count" integer DEFAULT 0,
	"is_pinned" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "helpdesk_feedback" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(30) DEFAULT 'feature_request' NOT NULL,
	"status" varchar(30) DEFAULT 'new' NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(100),
	"submitter_id" varchar(255) NOT NULL,
	"submitter_name" varchar(255) NOT NULL,
	"submitter_email" varchar(255) NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL,
	"voters" jsonb,
	"attachments" jsonb,
	"comments" jsonb,
	"assignee_id" varchar(255),
	"assignee_name" varchar(255),
	"estimated_completion" timestamp,
	"completed_at" timestamp,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "helpdesk_reviews" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(20) DEFAULT 'service' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"rating" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"reviewer_id" varchar(255) NOT NULL,
	"reviewer_name" varchar(255) NOT NULL,
	"reviewer_email" varchar(255) NOT NULL,
	"reviewer_avatar" varchar(500),
	"conversation_id" varchar(30),
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"helpful_voters" jsonb,
	"response" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_satisfaction_surveys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"ticket_id" varchar(30) NOT NULL,
	"customer_id" varchar(30) NOT NULL,
	"rating" integer,
	"comment" text,
	"responses" jsonb,
	"sent_at" timestamp NOT NULL,
	"responded_at" timestamp,
	"expires_at" timestamp,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"follow_up_required" boolean DEFAULT false,
	"follow_up_notes" text
);
--> statement-breakpoint
CREATE TABLE "helpdesk_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"general" jsonb,
	"tickets" jsonb,
	"notifications" jsonb,
	"satisfaction" jsonb,
	"integrations" jsonb,
	"customization" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_widget_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"widget_id" varchar(50),
	"widget_name" varchar(255),
	"page_home" boolean DEFAULT true,
	"page_chat" boolean DEFAULT true,
	"page_help" boolean DEFAULT true,
	"page_parcel_tracking" boolean DEFAULT false,
	"page_changelog" boolean DEFAULT true,
	"page_news" boolean DEFAULT true,
	"page_feedback" boolean DEFAULT true,
	"page_announcements" boolean DEFAULT true,
	"page_event_sign_up" boolean DEFAULT false,
	"color_primary" varchar(20),
	"color_button" varchar(20),
	"color_button_text" varchar(20),
	"color_launcher" varchar(20),
	"color_header" varchar(20),
	"color_accent" varchar(20),
	"border_radius" varchar(20),
	"font_size" varchar(20),
	"typography_text" varchar(20),
	"typography_background" varchar(20),
	"starting_page" varchar(50),
	"position" varchar(20),
	"auto_open" boolean DEFAULT false,
	"show_welcome_message" boolean DEFAULT true,
	"welcome_message" varchar(500),
	"company_logo_url" varchar(500),
	"chat_background_color" varchar(20),
	"user_bubble_color" varchar(20),
	"user_bubble_text_color" varchar(20),
	"agent_bubble_color" varchar(20),
	"agent_bubble_text_color" varchar(20)
);
--> statement-breakpoint
CREATE TABLE "helpdesk_channel_integrations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"provider" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"name" varchar(255) NOT NULL,
	"account_info" jsonb,
	"config" jsonb,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"last_sync_at" timestamp,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "user_app_assignments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"app_code" varchar(50) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now(),
	"granted_by" varchar(255),
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_user_app_assignment" UNIQUE("workspace_id","user_id","app_code")
);
--> statement-breakpoint
CREATE TABLE "workspace_installed_apps" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"app_code" varchar(50) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0,
	"settings" jsonb,
	"installed_at" timestamp with time zone DEFAULT now(),
	"installed_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "uq_workspace_installed_app" UNIQUE("workspace_id","app_code")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"theme" varchar(20) DEFAULT 'system' NOT NULL,
	"font_size" integer DEFAULT 16 NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"date_format" varchar(50) DEFAULT 'MM/DD/YYYY' NOT NULL,
	"time_format" varchar(10) DEFAULT '12h' NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"notifications" jsonb,
	"ui_preferences" jsonb,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"theme" text,
	"timezone" text,
	"currency" text,
	"language" text,
	"date_format" text,
	"time_format" text,
	"legal_name" varchar(255),
	"trading_name" varchar(255),
	"email" varchar(255),
	"phone" varchar(30),
	"address_line_1" varchar(255),
	"address_line_2" varchar(255),
	"city" varchar(100),
	"state" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"vat_number" varchar(50),
	"registration_number" varchar(50),
	"logo_url" varchar(500),
	"website_url" varchar(500),
	"primary_color" varchar(20),
	"accent_color" varchar(20),
	"email_notifications_enabled" boolean DEFAULT true NOT NULL,
	"push_notifications_enabled" boolean DEFAULT true NOT NULL,
	"features" jsonb,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"custom_settings" jsonb,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"email" varchar(255),
	"name" varchar(255),
	"picture" varchar(500),
	"role" varchar(20) DEFAULT 'MEMBER' NOT NULL,
	"role_id" varchar(30),
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"invited_by" varchar(255),
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_members_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"color" varchar(20),
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(20) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_api_keys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(20) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"device_id" varchar(255) NOT NULL,
	"platform" varchar(20) NOT NULL,
	"token" text NOT NULL,
	"token_type" varchar(20) DEFAULT 'fcm' NOT NULL,
	"app_version" varchar(50),
	"device_model" varchar(100),
	"os_version" varchar(50),
	"is_active" timestamp DEFAULT null,
	"last_used_at" timestamp,
	CONSTRAINT "device_tokens_user_device_unique" UNIQUE("user_id","device_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_messages" ADD CONSTRAINT "project_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD CONSTRAINT "project_whiteboards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_webhooks" ADD CONSTRAINT "workflow_webhooks_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_variables" ADD CONSTRAINT "workflow_variables_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_error_logs" ADD CONSTRAINT "workflow_error_logs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_error_logs" ADD CONSTRAINT "workflow_error_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_zone_id_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."dns_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_forwards" ADD CONSTRAINT "email_forwards_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_folder_id_mail_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mail_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_campaigns" ADD CONSTRAINT "mail_campaigns_template_id_mail_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."mail_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_labels" ADD CONSTRAINT "mail_labels_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD CONSTRAINT "helpdesk_conversation_messages_conversation_id_helpdesk_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."helpdesk_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_ticket_messages" ADD CONSTRAINT "helpdesk_ticket_messages_ticket_id_helpdesk_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_ticket_notes" ADD CONSTRAINT "helpdesk_ticket_notes_ticket_id_helpdesk_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_articles" ADD CONSTRAINT "helpdesk_articles_category_id_helpdesk_article_folders_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."helpdesk_article_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_code_idx" ON "projects" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "projects" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_is_active_idx" ON "projects" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_sprint_idx" ON "tasks" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "tasks_milestone_idx" ON "tasks" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "time_entries_project_idx" ON "time_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "time_entries_task_idx" ON "time_entries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "time_entries_date_idx" ON "time_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "time_entries_status_idx" ON "time_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "project_members_project_idx" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_members_role_idx" ON "project_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_status_idx" ON "milestones" USING btree ("status");--> statement-breakpoint
CREATE INDEX "milestones_due_date_idx" ON "milestones" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "project_files_project_idx" ON "project_files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_files_uploaded_by_idx" ON "project_files" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "project_files_file_type_idx" ON "project_files" USING btree ("file_type");--> statement-breakpoint
CREATE INDEX "project_messages_project_idx" ON "project_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_messages_conversation_idx" ON "project_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "project_messages_sender_idx" ON "project_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "project_messages_created_idx" ON "project_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sprints_project_idx" ON "sprints" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sprints_status_idx" ON "sprints" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sprints_start_date_idx" ON "sprints" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "project_whiteboards_project_idx" ON "project_whiteboards" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_project_idx" ON "project_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_documents_published_idx" ON "project_documents" USING btree ("is_published");--> statement-breakpoint
CREATE INDEX "workflows_workspace_idx" ON "workflows" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflows_status_idx" ON "workflows" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflows_created_by_idx" ON "workflows" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "workflows_folder_idx" ON "workflows" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workspace_idx" ON "workflow_executions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_idx" ON "workflow_executions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_status_idx" ON "workflow_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_executions_triggered_by_idx" ON "workflow_executions" USING btree ("triggered_by");--> statement-breakpoint
CREATE INDEX "workflow_executions_trigger_type_idx" ON "workflow_executions" USING btree ("trigger_type");--> statement-breakpoint
CREATE INDEX "workflow_executions_trigger_dev_run_idx" ON "workflow_executions" USING btree ("trigger_dev_run_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_started_at_idx" ON "workflow_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "workflow_execution_steps_workspace_idx" ON "workflow_execution_steps" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_execution_steps_execution_idx" ON "workflow_execution_steps" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "workflow_execution_steps_step_idx" ON "workflow_execution_steps" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "workflow_execution_steps_status_idx" ON "workflow_execution_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_triggers_workspace_idx" ON "workflow_triggers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_triggers_workflow_idx" ON "workflow_triggers" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_triggers_category_idx" ON "workflow_triggers" USING btree ("category");--> statement-breakpoint
CREATE INDEX "workflow_triggers_is_enabled_idx" ON "workflow_triggers" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "workflow_triggers_next_run_idx" ON "workflow_triggers" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "workflow_schedules_workspace_idx" ON "workflow_schedules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_schedules_workflow_idx" ON "workflow_schedules" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_schedules_is_enabled_idx" ON "workflow_schedules" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "workflow_schedules_next_run_idx" ON "workflow_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "workflow_webhooks_workspace_idx" ON "workflow_webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_webhooks_workflow_idx" ON "workflow_webhooks" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_webhooks_url_idx" ON "workflow_webhooks" USING btree ("url");--> statement-breakpoint
CREATE INDEX "workflow_webhooks_is_enabled_idx" ON "workflow_webhooks" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "workflow_variables_workspace_idx" ON "workflow_variables" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_variables_workflow_idx" ON "workflow_variables" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_variables_scope_idx" ON "workflow_variables" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "workflow_variables_name_idx" ON "workflow_variables" USING btree ("name");--> statement-breakpoint
CREATE INDEX "workflow_variables_is_secret_idx" ON "workflow_variables" USING btree ("is_secret");--> statement-breakpoint
CREATE INDEX "workflow_integrations_workspace_idx" ON "workflow_integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_integrations_type_idx" ON "workflow_integrations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "workflow_integrations_status_idx" ON "workflow_integrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_integrations_category_idx" ON "workflow_integrations" USING btree ("category");--> statement-breakpoint
CREATE INDEX "workflow_templates_workspace_idx" ON "workflow_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_templates_category_idx" ON "workflow_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "workflow_templates_is_public_idx" ON "workflow_templates" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "workflow_templates_is_official_idx" ON "workflow_templates" USING btree ("is_official");--> statement-breakpoint
CREATE INDEX "workflow_templates_author_idx" ON "workflow_templates" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "workflow_templates_usage_idx" ON "workflow_templates" USING btree ("usage_count");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_workspace_idx" ON "workflow_error_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_workflow_idx" ON "workflow_error_logs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_execution_idx" ON "workflow_error_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_severity_idx" ON "workflow_error_logs" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_is_acknowledged_idx" ON "workflow_error_logs" USING btree ("is_acknowledged");--> statement-breakpoint
CREATE INDEX "workflow_error_logs_occurred_at_idx" ON "workflow_error_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "workspace_storage_workspace_idx" ON "workspace_storage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pending_uploads_workspace_idx" ON "pending_uploads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pending_uploads_user_idx" ON "pending_uploads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pending_uploads_expires_idx" ON "pending_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "customers_workspace_idx" ON "customers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customers_type_idx" ON "customers" USING btree ("type");--> statement-breakpoint
CREATE INDEX "customers_status_idx" ON "customers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customers_owner_idx" ON "customers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "customers_company_name_idx" ON "customers" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "contacts_workspace_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_customer_idx" ON "contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_is_primary_idx" ON "contacts" USING btree ("is_primary");--> statement-breakpoint
CREATE INDEX "contacts_status_idx" ON "contacts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_workspace_idx" ON "products" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_sku_idx" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_product_type_idx" ON "products" USING btree ("product_type");--> statement-breakpoint
CREATE INDEX "categories_workspace_idx" ON "categories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_path_idx" ON "categories" USING btree ("path");--> statement-breakpoint
CREATE INDEX "category_products_workspace_idx" ON "category_products" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "category_products_category_idx" ON "category_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "category_products_product_idx" ON "category_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_workspace_idx" ON "order_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_workspace_idx" ON "orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "orders_order_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_payment_status_idx" ON "orders" USING btree ("payment_status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_connections_workspace_idx" ON "product_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "product_connections_product_idx" ON "product_connections" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_connections_platform_idx" ON "product_connections" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "product_connections_connection_idx" ON "product_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "crm_pipeline_stages_workspace_idx" ON "crm_pipeline_stages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_pipeline_stages_position_idx" ON "crm_pipeline_stages" USING btree ("position");--> statement-breakpoint
CREATE INDEX "crm_pipeline_stages_pipeline_idx" ON "crm_pipeline_stages" USING btree ("pipeline");--> statement-breakpoint
CREATE INDEX "crm_leads_workspace_idx" ON "crm_leads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_leads_email_idx" ON "crm_leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "crm_leads_status_idx" ON "crm_leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_leads_source_idx" ON "crm_leads" USING btree ("source");--> statement-breakpoint
CREATE INDEX "crm_leads_owner_idx" ON "crm_leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "crm_leads_is_qualified_idx" ON "crm_leads" USING btree ("is_qualified");--> statement-breakpoint
CREATE INDEX "crm_opportunities_workspace_idx" ON "crm_opportunities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_customer_idx" ON "crm_opportunities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_stage_idx" ON "crm_opportunities" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "crm_opportunities_stage_id_idx" ON "crm_opportunities" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_status_idx" ON "crm_opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_opportunities_owner_idx" ON "crm_opportunities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_close_date_idx" ON "crm_opportunities" USING btree ("close_date");--> statement-breakpoint
CREATE INDEX "crm_opportunities_pipeline_idx" ON "crm_opportunities" USING btree ("pipeline");--> statement-breakpoint
CREATE INDEX "crm_activities_workspace_idx" ON "crm_activities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_activities_type_idx" ON "crm_activities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "crm_activities_customer_idx" ON "crm_activities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_activities_contact_idx" ON "crm_activities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_activities_lead_idx" ON "crm_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "crm_activities_opportunity_idx" ON "crm_activities" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "crm_activities_assigned_to_idx" ON "crm_activities" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "crm_activities_status_idx" ON "crm_activities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_activities_due_date_idx" ON "crm_activities" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "crm_transcript_segments_transcription_idx" ON "crm_transcript_segments" USING btree ("transcription_id");--> statement-breakpoint
CREATE INDEX "crm_transcript_segments_speaker_idx" ON "crm_transcript_segments" USING btree ("speaker_id");--> statement-breakpoint
CREATE INDEX "crm_transcriptions_workspace_idx" ON "crm_transcriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_transcriptions_activity_idx" ON "crm_transcriptions" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "crm_transcriptions_status_idx" ON "crm_transcriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_quotes_workspace_idx" ON "crm_quotes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_quotes_quote_number_idx" ON "crm_quotes" USING btree ("quote_number");--> statement-breakpoint
CREATE INDEX "crm_quotes_customer_idx" ON "crm_quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_quotes_opportunity_idx" ON "crm_quotes" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "crm_quotes_status_idx" ON "crm_quotes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_quotes_valid_until_idx" ON "crm_quotes" USING btree ("valid_until");--> statement-breakpoint
CREATE INDEX "meeting_bot_instances_status_idx" ON "meeting_bot_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_workspace_idx" ON "meeting_bot_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_user_idx" ON "meeting_bot_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_status_idx" ON "meeting_bot_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_platform_idx" ON "meeting_bot_sessions" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_contact_idx" ON "meeting_bot_sessions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_opportunity_idx" ON "meeting_bot_sessions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_external_session_idx" ON "meeting_bot_sessions" USING btree ("external_session_id");--> statement-breakpoint
CREATE INDEX "commerce_cart_items_workspace_idx" ON "commerce_cart_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_cart_items_cart_idx" ON "commerce_cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "commerce_cart_items_product_idx" ON "commerce_cart_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "commerce_carts_workspace_idx" ON "commerce_carts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_carts_session_idx" ON "commerce_carts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "commerce_carts_customer_idx" ON "commerce_carts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "commerce_carts_status_idx" ON "commerce_carts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commerce_discount_usage_workspace_idx" ON "commerce_discount_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_discount_usage_discount_idx" ON "commerce_discount_usage" USING btree ("discount_id");--> statement-breakpoint
CREATE INDEX "commerce_discount_usage_customer_idx" ON "commerce_discount_usage" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "commerce_discounts_workspace_idx" ON "commerce_discounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_discounts_code_idx" ON "commerce_discounts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "commerce_discounts_status_idx" ON "commerce_discounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commerce_discounts_starts_at_idx" ON "commerce_discounts" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "commerce_discounts_ends_at_idx" ON "commerce_discounts" USING btree ("ends_at");--> statement-breakpoint
CREATE INDEX "commerce_websites_workspace_idx" ON "commerce_websites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_websites_slug_idx" ON "commerce_websites" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "commerce_websites_status_idx" ON "commerce_websites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commerce_website_pages_workspace_idx" ON "commerce_website_pages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_website_pages_website_idx" ON "commerce_website_pages" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "commerce_website_pages_slug_idx" ON "commerce_website_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "commerce_website_pages_path_idx" ON "commerce_website_pages" USING btree ("path");--> statement-breakpoint
CREATE INDEX "commerce_website_pages_status_idx" ON "commerce_website_pages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commerce_website_sections_workspace_idx" ON "commerce_website_sections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_website_sections_website_idx" ON "commerce_website_sections" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "commerce_website_sections_page_idx" ON "commerce_website_sections" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "commerce_website_sections_type_idx" ON "commerce_website_sections" USING btree ("type");--> statement-breakpoint
CREATE INDEX "commerce_website_sections_position_idx" ON "commerce_website_sections" USING btree ("position");--> statement-breakpoint
CREATE INDEX "commerce_website_domains_workspace_idx" ON "commerce_website_domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "commerce_website_domains_website_idx" ON "commerce_website_domains" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "commerce_website_domains_domain_idx" ON "commerce_website_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "commerce_website_domains_is_primary_idx" ON "commerce_website_domains" USING btree ("is_primary");--> statement-breakpoint
CREATE INDEX "domains_workspace_id_idx" ON "domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "domains_full_domain_idx" ON "domains" USING btree ("full_domain");--> statement-breakpoint
CREATE INDEX "domains_status_idx" ON "domains" USING btree ("status");--> statement-breakpoint
CREATE INDEX "domains_expires_at_idx" ON "domains" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "domains_external_registrar_id_idx" ON "domains" USING btree ("external_registrar_id");--> statement-breakpoint
CREATE INDEX "dns_zones_workspace_id_idx" ON "dns_zones" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dns_zones_domain_id_idx" ON "dns_zones" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "dns_zones_external_zone_id_idx" ON "dns_zones" USING btree ("external_zone_id");--> statement-breakpoint
CREATE INDEX "dns_zones_status_idx" ON "dns_zones" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dns_records_workspace_id_idx" ON "dns_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dns_records_zone_id_idx" ON "dns_records" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "dns_records_type_idx" ON "dns_records" USING btree ("type");--> statement-breakpoint
CREATE INDEX "dns_records_name_idx" ON "dns_records" USING btree ("name");--> statement-breakpoint
CREATE INDEX "dns_records_external_record_id_idx" ON "dns_records" USING btree ("external_record_id");--> statement-breakpoint
CREATE INDEX "email_forwards_workspace_id_idx" ON "email_forwards" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "email_forwards_domain_id_idx" ON "email_forwards" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "email_forwards_source_idx" ON "email_forwards" USING btree ("source");--> statement-breakpoint
CREATE INDEX "email_forwards_enabled_idx" ON "email_forwards" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "domain_transfers_workspace_id_idx" ON "domain_transfers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "domain_transfers_domain_id_idx" ON "domain_transfers" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "domain_transfers_domain_name_idx" ON "domain_transfers" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "domain_transfers_status_idx" ON "domain_transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "domain_transfers_type_idx" ON "domain_transfers" USING btree ("type");--> statement-breakpoint
CREATE INDEX "domain_transfers_external_transfer_id_idx" ON "domain_transfers" USING btree ("external_transfer_id");--> statement-breakpoint
CREATE INDEX "mail_accounts_workspace_id_idx" ON "mail_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_accounts_email_idx" ON "mail_accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mail_accounts_status_idx" ON "mail_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mail_accounts_is_default_idx" ON "mail_accounts" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "mail_accounts_external_account_id_idx" ON "mail_accounts" USING btree ("external_account_id");--> statement-breakpoint
CREATE INDEX "mail_domains_workspace_id_idx" ON "mail_domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_domains_domain_name_idx" ON "mail_domains" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "mail_domains_is_active_idx" ON "mail_domains" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "mail_domains_is_primary_idx" ON "mail_domains" USING btree ("is_primary");--> statement-breakpoint
CREATE INDEX "mail_domains_external_domain_id_idx" ON "mail_domains" USING btree ("external_domain_id");--> statement-breakpoint
CREATE INDEX "mail_folders_workspace_id_idx" ON "mail_folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_folders_account_id_idx" ON "mail_folders" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_folders_type_idx" ON "mail_folders" USING btree ("type");--> statement-breakpoint
CREATE INDEX "mail_folders_parent_id_idx" ON "mail_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "mail_folders_is_system_idx" ON "mail_folders" USING btree ("is_system");--> statement-breakpoint
CREATE INDEX "mail_messages_workspace_id_idx" ON "mail_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_messages_account_id_idx" ON "mail_messages" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_messages_folder_id_idx" ON "mail_messages" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "mail_messages_message_id_idx" ON "mail_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_messages_thread_id_idx" ON "mail_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "mail_messages_is_read_idx" ON "mail_messages" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "mail_messages_is_starred_idx" ON "mail_messages" USING btree ("is_starred");--> statement-breakpoint
CREATE INDEX "mail_messages_sent_date_idx" ON "mail_messages" USING btree ("sent_date");--> statement-breakpoint
CREATE INDEX "mail_messages_external_message_id_idx" ON "mail_messages" USING btree ("external_message_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_workspace_id_idx" ON "mail_attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_message_id_idx" ON "mail_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_attachments_content_type_idx" ON "mail_attachments" USING btree ("content_type");--> statement-breakpoint
CREATE INDEX "mail_attachments_is_inline_idx" ON "mail_attachments" USING btree ("is_inline");--> statement-breakpoint
CREATE INDEX "mail_drafts_workspace_id_idx" ON "mail_drafts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_drafts_account_id_idx" ON "mail_drafts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_drafts_updated_at_idx" ON "mail_drafts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "mail_templates_workspace_id_idx" ON "mail_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_templates_type_idx" ON "mail_templates" USING btree ("type");--> statement-breakpoint
CREATE INDEX "mail_templates_category_idx" ON "mail_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "mail_templates_is_active_idx" ON "mail_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "mail_templates_is_default_idx" ON "mail_templates" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "mail_campaigns_workspace_id_idx" ON "mail_campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_campaigns_template_id_idx" ON "mail_campaigns" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "mail_campaigns_status_idx" ON "mail_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mail_campaigns_scheduled_at_idx" ON "mail_campaigns" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "mail_campaigns_sent_at_idx" ON "mail_campaigns" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "mail_rules_workspace_id_idx" ON "mail_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_rules_account_id_idx" ON "mail_rules" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_rules_is_active_idx" ON "mail_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "mail_rules_priority_idx" ON "mail_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "mail_signatures_workspace_id_idx" ON "mail_signatures" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_signatures_is_default_idx" ON "mail_signatures" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "mail_signatures_type_idx" ON "mail_signatures" USING btree ("type");--> statement-breakpoint
CREATE INDEX "mail_contacts_workspace_id_idx" ON "mail_contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_contacts_email_idx" ON "mail_contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mail_contacts_name_idx" ON "mail_contacts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "mail_contacts_is_blocked_idx" ON "mail_contacts" USING btree ("is_blocked");--> statement-breakpoint
CREATE INDEX "mail_contacts_is_vip_idx" ON "mail_contacts" USING btree ("is_vip");--> statement-breakpoint
CREATE INDEX "mail_contacts_is_bounced_idx" ON "mail_contacts" USING btree ("is_bounced");--> statement-breakpoint
CREATE INDEX "mail_contacts_is_unsubscribed_idx" ON "mail_contacts" USING btree ("is_unsubscribed");--> statement-breakpoint
CREATE INDEX "mail_labels_workspace_id_idx" ON "mail_labels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_labels_account_id_idx" ON "mail_labels" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_labels_name_idx" ON "mail_labels" USING btree ("name");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_workspace_idx" ON "helpdesk_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_user_idx" ON "helpdesk_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_department_idx" ON "helpdesk_agents" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_status_idx" ON "helpdesk_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_availability_idx" ON "helpdesk_agents" USING btree ("availability");--> statement-breakpoint
CREATE INDEX "helpdesk_agents_email_idx" ON "helpdesk_agents" USING btree ("email");--> statement-breakpoint
CREATE INDEX "helpdesk_departments_workspace_idx" ON "helpdesk_departments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_departments_manager_idx" ON "helpdesk_departments" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "helpdesk_departments_is_active_idx" ON "helpdesk_departments" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_workspace_idx" ON "helpdesk_conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_customer_id_idx" ON "helpdesk_conversations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_customer_email_idx" ON "helpdesk_conversations" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_status_idx" ON "helpdesk_conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_assignee_idx" ON "helpdesk_conversations" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_department_idx" ON "helpdesk_conversations" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_channel_idx" ON "helpdesk_conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_is_read_idx" ON "helpdesk_conversations" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_is_archived_idx" ON "helpdesk_conversations" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_last_message_idx" ON "helpdesk_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_number_idx" ON "helpdesk_conversations" USING btree ("conversation_number");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_workspace_idx" ON "helpdesk_conversation_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_conversation_idx" ON "helpdesk_conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_author_idx" ON "helpdesk_conversation_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_author_type_idx" ON "helpdesk_conversation_messages" USING btree ("author_type");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_type_idx" ON "helpdesk_conversation_messages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_is_public_idx" ON "helpdesk_conversation_messages" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_created_at_idx" ON "helpdesk_conversation_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_workspace_idx" ON "helpdesk_tickets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_customer_id_idx" ON "helpdesk_tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_customer_email_idx" ON "helpdesk_tickets" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_status_idx" ON "helpdesk_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_priority_idx" ON "helpdesk_tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_category_idx" ON "helpdesk_tickets" USING btree ("category");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_assignee_idx" ON "helpdesk_tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_department_idx" ON "helpdesk_tickets" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_channel_idx" ON "helpdesk_tickets" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_sla_status_idx" ON "helpdesk_tickets" USING btree ("sla_status");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_number_idx" ON "helpdesk_tickets" USING btree ("ticket_number");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_created_at_idx" ON "helpdesk_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_workspace_idx" ON "helpdesk_ticket_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_ticket_idx" ON "helpdesk_ticket_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_author_idx" ON "helpdesk_ticket_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_author_type_idx" ON "helpdesk_ticket_messages" USING btree ("author_type");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_type_idx" ON "helpdesk_ticket_messages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_is_public_idx" ON "helpdesk_ticket_messages" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_messages_created_at_idx" ON "helpdesk_ticket_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_notes_workspace_idx" ON "helpdesk_ticket_notes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_notes_ticket_idx" ON "helpdesk_ticket_notes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_notes_author_idx" ON "helpdesk_ticket_notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_notes_created_at_idx" ON "helpdesk_ticket_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_article_folders_workspace_idx" ON "helpdesk_article_folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_article_folders_parent_idx" ON "helpdesk_article_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "helpdesk_article_folders_slug_idx" ON "helpdesk_article_folders" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "helpdesk_article_folders_sort_order_idx" ON "helpdesk_article_folders" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_workspace_idx" ON "helpdesk_articles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_category_id_idx" ON "helpdesk_articles" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_author_idx" ON "helpdesk_articles" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_status_idx" ON "helpdesk_articles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_visibility_idx" ON "helpdesk_articles" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_slug_idx" ON "helpdesk_articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_published_at_idx" ON "helpdesk_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "helpdesk_articles_is_pinned_idx" ON "helpdesk_articles" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "helpdesk_faqs_workspace_idx" ON "helpdesk_faqs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_faqs_category_idx" ON "helpdesk_faqs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "helpdesk_faqs_is_published_idx" ON "helpdesk_faqs" USING btree ("is_published");--> statement-breakpoint
CREATE INDEX "helpdesk_faqs_order_idx" ON "helpdesk_faqs" USING btree ("order");--> statement-breakpoint
CREATE INDEX "helpdesk_slas_workspace_idx" ON "helpdesk_slas" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_slas_is_active_idx" ON "helpdesk_slas" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "helpdesk_slas_is_default_idx" ON "helpdesk_slas" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "helpdesk_slas_priority_idx" ON "helpdesk_slas" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_workspace_idx" ON "helpdesk_canned_responses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_scope_idx" ON "helpdesk_canned_responses" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_agent_idx" ON "helpdesk_canned_responses" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_department_idx" ON "helpdesk_canned_responses" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_category_idx" ON "helpdesk_canned_responses" USING btree ("category");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_is_active_idx" ON "helpdesk_canned_responses" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "helpdesk_canned_responses_shortcut_idx" ON "helpdesk_canned_responses" USING btree ("shortcut");--> statement-breakpoint
CREATE INDEX "helpdesk_contacts_workspace_idx" ON "helpdesk_contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_contacts_email_idx" ON "helpdesk_contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "helpdesk_contacts_name_idx" ON "helpdesk_contacts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "helpdesk_contacts_company_idx" ON "helpdesk_contacts" USING btree ("company");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_workspace_idx" ON "helpdesk_announcements" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_status_idx" ON "helpdesk_announcements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_visibility_idx" ON "helpdesk_announcements" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_type_idx" ON "helpdesk_announcements" USING btree ("type");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_published_at_idx" ON "helpdesk_announcements" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "helpdesk_announcements_is_pinned_idx" ON "helpdesk_announcements" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "helpdesk_changelog_workspace_idx" ON "helpdesk_changelog" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_changelog_status_idx" ON "helpdesk_changelog" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_changelog_version_idx" ON "helpdesk_changelog" USING btree ("version");--> statement-breakpoint
CREATE INDEX "helpdesk_changelog_release_date_idx" ON "helpdesk_changelog" USING btree ("release_date");--> statement-breakpoint
CREATE INDEX "helpdesk_news_workspace_idx" ON "helpdesk_news" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_news_status_idx" ON "helpdesk_news" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_news_category_idx" ON "helpdesk_news" USING btree ("category");--> statement-breakpoint
CREATE INDEX "helpdesk_news_published_at_idx" ON "helpdesk_news" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "helpdesk_news_is_pinned_idx" ON "helpdesk_news" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_workspace_idx" ON "helpdesk_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_type_idx" ON "helpdesk_feedback" USING btree ("type");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_status_idx" ON "helpdesk_feedback" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_priority_idx" ON "helpdesk_feedback" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_submitter_idx" ON "helpdesk_feedback" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_assignee_idx" ON "helpdesk_feedback" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "helpdesk_feedback_votes_idx" ON "helpdesk_feedback" USING btree ("votes");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_workspace_idx" ON "helpdesk_reviews" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_type_idx" ON "helpdesk_reviews" USING btree ("type");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_status_idx" ON "helpdesk_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_rating_idx" ON "helpdesk_reviews" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_reviewer_idx" ON "helpdesk_reviews" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "helpdesk_reviews_is_featured_idx" ON "helpdesk_reviews" USING btree ("is_featured");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_workspace_idx" ON "helpdesk_satisfaction_surveys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_ticket_idx" ON "helpdesk_satisfaction_surveys" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_customer_idx" ON "helpdesk_satisfaction_surveys" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_status_idx" ON "helpdesk_satisfaction_surveys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_rating_idx" ON "helpdesk_satisfaction_surveys" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_sent_at_idx" ON "helpdesk_satisfaction_surveys" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "helpdesk_settings_workspace_idx" ON "helpdesk_settings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_widget_settings_workspace_idx" ON "helpdesk_widget_settings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_widget_settings_widget_id_idx" ON "helpdesk_widget_settings" USING btree ("widget_id");--> statement-breakpoint
CREATE INDEX "helpdesk_channel_integrations_workspace_idx" ON "helpdesk_channel_integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_channel_integrations_provider_idx" ON "helpdesk_channel_integrations" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "helpdesk_channel_integrations_status_idx" ON "helpdesk_channel_integrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "roles_workspace_idx" ON "roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "workspace_api_keys_workspace_idx" ON "workspace_api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_api_keys_key_prefix_idx" ON "workspace_api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "device_tokens_workspace_idx" ON "device_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "device_tokens_user_idx" ON "device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_tokens_platform_idx" ON "device_tokens" USING btree ("platform");