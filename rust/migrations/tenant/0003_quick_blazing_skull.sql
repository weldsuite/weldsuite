CREATE TYPE "public"."social_account_status" AS ENUM('active', 'inactive', 'expired', 'error', 'pending_reauth');--> statement-breakpoint
CREATE TYPE "public"."social_account_type" AS ENUM('business', 'creator', 'personal');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('facebook', 'instagram', 'twitter', 'linkedin', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."social_post_status" AS ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."social_post_type" AS ENUM('post', 'story', 'reel', 'thread', 'carousel', 'poll');--> statement-breakpoint
CREATE TYPE "public"."social_media_status" AS ENUM('uploading', 'processing', 'ready', 'error', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."social_media_type" AS ENUM('image', 'video', 'gif');--> statement-breakpoint
CREATE TYPE "public"."social_analytics_snapshot_period" AS ENUM('hourly', 'daily', 'weekly', 'monthly', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."social_team_role" AS ENUM('owner', 'admin', 'manager', 'editor', 'contributor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."social_approval_action" AS ENUM('submitted', 'approved', 'rejected', 'revision_requested', 'withdrawn', 'auto_approved', 'escalated', 'reassigned');--> statement-breakpoint
CREATE TYPE "public"."social_approval_status" AS ENUM('pending', 'approved', 'rejected', 'revision_requested', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."social_campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"platform" "social_platform" NOT NULL,
	"platform_account_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"username" varchar(255),
	"profile_url" varchar(1000),
	"avatar_url" varchar(1000),
	"account_type" "social_account_type" DEFAULT 'business',
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"scopes" jsonb,
	"platform_settings" jsonb,
	"status" "social_account_status" DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp,
	"last_error" text,
	"error_count" integer DEFAULT 0,
	"rate_limits" jsonb,
	"follower_count" integer,
	"following_count" integer,
	"post_count" integer,
	"stats_updated_at" timestamp,
	"connected_by_user_id" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false,
	"auto_publish" boolean DEFAULT true,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(255),
	"content" text NOT NULL,
	"post_type" "social_post_type" DEFAULT 'post' NOT NULL,
	"status" "social_post_status" DEFAULT 'draft' NOT NULL,
	"target_account_ids" jsonb NOT NULL,
	"platform_content" jsonb,
	"media_ids" jsonb,
	"scheduled_at" timestamp,
	"published_at" timestamp,
	"timezone" varchar(50) DEFAULT 'UTC',
	"queue_position" integer,
	"hashtag_settings" jsonb,
	"link_settings" jsonb,
	"poll_config" jsonb,
	"location" jsonb,
	"first_comment" jsonb,
	"mentions" jsonb,
	"created_by_user_id" varchar(255) NOT NULL,
	"last_edited_by_user_id" varchar(255),
	"approval_requested_at" timestamp,
	"approved_at" timestamp,
	"approved_by_user_id" varchar(255),
	"rejected_at" timestamp,
	"rejected_by_user_id" varchar(255),
	"rejection_reason" text,
	"publish_attempts" integer DEFAULT 0,
	"last_publish_error" text,
	"last_publish_attempt_at" timestamp,
	"calendar_color" varchar(20),
	"campaign_id" varchar(30),
	"labels" jsonb,
	"tags" jsonb,
	"internal_notes" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "social_media" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"file_name" varchar(500) NOT NULL,
	"original_name" varchar(500),
	"mime_type" varchar(255) NOT NULL,
	"file_size" bigint NOT NULL,
	"media_type" "social_media_type" NOT NULL,
	"storage_path" varchar(1000) NOT NULL,
	"file_key" varchar(1000),
	"bucket" varchar(255),
	"url" varchar(1000),
	"storage_provider" varchar(50) DEFAULT 'r2' NOT NULL,
	"thumbnail_url" varchar(1000),
	"thumbnails" jsonb,
	"dimensions" jsonb,
	"video_metadata" jsonb,
	"status" "social_media_status" DEFAULT 'uploading' NOT NULL,
	"processing_error" text,
	"processed_at" timestamp,
	"uploaded_by_user_id" varchar(255) NOT NULL,
	"folder_id" varchar(30),
	"tags" jsonb,
	"alt_text" text,
	"description" text,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"platform_compatibility" jsonb,
	"checksum" varchar(64),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "social_analytics" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"post_id" varchar(30) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"platform_post_id" varchar(255),
	"snapshot_period" "social_analytics_snapshot_period" DEFAULT 'lifetime' NOT NULL,
	"snapshot_at" timestamp NOT NULL,
	"impressions" bigint DEFAULT 0,
	"reach" bigint DEFAULT 0,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"saves" integer DEFAULT 0,
	"video_views" integer DEFAULT 0,
	"video_analytics" jsonb,
	"clicks" integer DEFAULT 0,
	"click_breakdown" jsonb,
	"engagement_rate" real,
	"click_through_rate" real,
	"total_engagement" integer DEFAULT 0,
	"engagement_breakdown" jsonb,
	"reach_breakdown" jsonb,
	"audience_demographics" jsonb,
	"follows_from_post" integer DEFAULT 0,
	"profile_visits" integer DEFAULT 0,
	"story_replies" integer,
	"story_exits" integer,
	"story_taps_forward" integer,
	"story_taps_back" integer,
	"hashtag_reach" jsonb,
	"peak_engagement_hour" integer,
	"raw_data" jsonb,
	CONSTRAINT "social_analytics_unique_snapshot" UNIQUE("post_id","account_id","snapshot_period","snapshot_at")
);
--> statement-breakpoint
CREATE TABLE "social_team_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255) NOT NULL,
	"email" varchar(255),
	"name" varchar(255),
	"avatar_url" varchar(500),
	"role" "social_team_role" DEFAULT 'contributor' NOT NULL,
	"permissions" jsonb,
	"account_access" jsonb,
	"can_access_all_accounts" boolean DEFAULT false,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by_user_id" varchar(255),
	"invited_at" timestamp,
	"accepted_at" timestamp,
	"last_active_at" timestamp,
	"notification_preferences" jsonb,
	"metadata" jsonb,
	CONSTRAINT "social_team_members_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "social_approval_history" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approval_id" varchar(30) NOT NULL,
	"post_id" varchar(30) NOT NULL,
	"action" "social_approval_action" NOT NULL,
	"actor_user_id" varchar(255) NOT NULL,
	"actor_name" varchar(255),
	"notes" text,
	"previous_status" varchar(30),
	"new_status" varchar(30),
	"post_snapshot" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "social_approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"post_id" varchar(30) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "social_approval_status" DEFAULT 'pending' NOT NULL,
	"submitted_by_user_id" varchar(255) NOT NULL,
	"submitted_at" timestamp NOT NULL,
	"submission_notes" text,
	"assigned_to_user_id" varchar(255),
	"assigned_at" timestamp,
	"assigned_by_user_id" varchar(255),
	"decided_by_user_id" varchar(255),
	"decided_at" timestamp,
	"decision_notes" text,
	"rejection_reason" text,
	"revision_details" jsonb,
	"priority" varchar(20) DEFAULT 'normal',
	"due_by" timestamp,
	"is_escalated" boolean DEFAULT false,
	"escalated_at" timestamp,
	"escalated_to_user_id" varchar(255),
	"escalation_reason" text,
	"was_auto_approved" boolean DEFAULT false,
	"auto_approval_reason" text,
	"triggered_rules" jsonb,
	"expires_at" timestamp,
	"reminders_sent" integer DEFAULT 0,
	"last_reminder_at" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "social_campaigns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"color" varchar(20),
	"status" "social_campaign_status" DEFAULT 'draft' NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"target_account_ids" jsonb,
	"goals" jsonb,
	"performance" jsonb,
	"tags" jsonb,
	"labels" jsonb,
	"created_by_user_id" varchar(255) NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "social_analytics" ADD CONSTRAINT "social_analytics_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_analytics" ADD CONSTRAINT "social_analytics_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_approval_history" ADD CONSTRAINT "social_approval_history_approval_id_social_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."social_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_approval_history" ADD CONSTRAINT "social_approval_history_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_approvals" ADD CONSTRAINT "social_approvals_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_accounts_workspace_idx" ON "social_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_accounts_platform_idx" ON "social_accounts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "social_accounts_status_idx" ON "social_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_account_idx" ON "social_accounts" USING btree ("workspace_id","platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "social_posts_workspace_idx" ON "social_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_posts_status_idx" ON "social_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_posts_scheduled_at_idx" ON "social_posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "social_posts_published_at_idx" ON "social_posts" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "social_posts_created_by_idx" ON "social_posts" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "social_posts_campaign_idx" ON "social_posts" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "social_posts_post_type_idx" ON "social_posts" USING btree ("post_type");--> statement-breakpoint
CREATE INDEX "social_media_workspace_idx" ON "social_media" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_media_type_idx" ON "social_media" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "social_media_status_idx" ON "social_media" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_media_folder_idx" ON "social_media" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "social_media_uploaded_by_idx" ON "social_media" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "social_media_checksum_idx" ON "social_media" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "social_analytics_workspace_idx" ON "social_analytics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_analytics_post_idx" ON "social_analytics" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "social_analytics_account_idx" ON "social_analytics" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "social_analytics_snapshot_at_idx" ON "social_analytics" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "social_analytics_period_idx" ON "social_analytics" USING btree ("snapshot_period");--> statement-breakpoint
CREATE INDEX "social_team_members_workspace_idx" ON "social_team_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_team_members_user_idx" ON "social_team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "social_team_members_role_idx" ON "social_team_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX "social_team_members_is_active_idx" ON "social_team_members" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "social_approval_history_workspace_idx" ON "social_approval_history" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_approval_history_approval_idx" ON "social_approval_history" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "social_approval_history_post_idx" ON "social_approval_history" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "social_approval_history_actor_idx" ON "social_approval_history" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "social_approval_history_created_at_idx" ON "social_approval_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "social_approvals_workspace_idx" ON "social_approvals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_approvals_post_idx" ON "social_approvals" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "social_approvals_status_idx" ON "social_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_approvals_submitted_by_idx" ON "social_approvals" USING btree ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "social_approvals_assigned_to_idx" ON "social_approvals" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "social_approvals_decided_at_idx" ON "social_approvals" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "social_approvals_due_by_idx" ON "social_approvals" USING btree ("due_by");--> statement-breakpoint
CREATE INDEX "social_campaigns_workspace_idx" ON "social_campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "social_campaigns_status_idx" ON "social_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_campaigns_start_date_idx" ON "social_campaigns" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "social_campaigns_end_date_idx" ON "social_campaigns" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "social_campaigns_created_by_idx" ON "social_campaigns" USING btree ("created_by_user_id");