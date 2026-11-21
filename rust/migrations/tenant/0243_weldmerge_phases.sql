CREATE TABLE "merge_chat_subscriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"team_id" varchar(30),
	"repository_id" varchar(30),
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"digest_hour" integer DEFAULT 9 NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_external_issues" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"issue_id" varchar(30) NOT NULL,
	"repository_id" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"url" varchar(1000) NOT NULL,
	"state" varchar(10) NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"last_writer" varchar(20) NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_inbox_states" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"item_key" varchar(200) NOT NULL,
	"read_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_record_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"issue_id" varchar(30) NOT NULL,
	"record_type" varchar(30) NOT NULL,
	"record_id" varchar(255) NOT NULL,
	"title" varchar(500),
	"created_by_user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_release_pull_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"release_id" varchar(30) NOT NULL,
	"pull_request_id" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_releases" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"team_id" varchar(30) NOT NULL,
	"repository_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(100),
	"base_ref" varchar(500),
	"head_ref" varchar(500),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"notes" text,
	"notes_generated_at" timestamp with time zone,
	"knowledge_page_id" varchar(30),
	"shipped_at" timestamp with time zone,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "merge_provider_accounts_login_idx";--> statement-breakpoint
DROP INDEX "merge_provider_accounts_user_idx";--> statement-breakpoint
ALTER TABLE "merge_comments" ALTER COLUMN "author_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "merge_issue_id" varchar(30);--> statement-breakpoint
ALTER TABLE "merge_comments" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_comments" ADD COLUMN "external_author_login" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_comments" ADD COLUMN "external_author_avatar_url" varchar(1000);--> statement-breakpoint
ALTER TABLE "merge_comments" ADD COLUMN "source" varchar(20) DEFAULT 'weldmerge' NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "app_slug" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "installed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_connections" ADD COLUMN "oauth_user_login" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_issue_pull_requests" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_issues" ADD COLUMN "agent_id" varchar(30);--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "host" varchar(500);--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "credentials" text;--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "credentials_expire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "avatar_url" varchar(1000);--> statement-breakpoint
ALTER TABLE "merge_provider_accounts" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_repositories" ADD COLUMN "external_project" varchar(500);--> statement-breakpoint
ALTER TABLE "merge_repositories" ADD COLUMN "webhook_id" varchar(255);--> statement-breakpoint
ALTER TABLE "merge_repositories" ADD COLUMN "webhook_key" varchar(64);--> statement-breakpoint
ALTER TABLE "merge_repositories" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
CREATE INDEX "merge_chat_subscriptions_channel_idx" ON "merge_chat_subscriptions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "merge_chat_subscriptions_team_idx" ON "merge_chat_subscriptions" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "merge_chat_subscriptions_repository_idx" ON "merge_chat_subscriptions" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_external_issues_issue_idx" ON "merge_external_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_external_issues_repo_number_idx" ON "merge_external_issues" USING btree ("repository_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_inbox_states_user_item_idx" ON "merge_inbox_states" USING btree ("user_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_record_links_unique_idx" ON "merge_record_links" USING btree ("issue_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "merge_record_links_record_idx" ON "merge_record_links" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_release_pull_requests_pair_idx" ON "merge_release_pull_requests" USING btree ("release_id","pull_request_id");--> statement-breakpoint
CREATE INDEX "merge_release_pull_requests_pr_idx" ON "merge_release_pull_requests" USING btree ("pull_request_id");--> statement-breakpoint
CREATE INDEX "merge_releases_team_idx" ON "merge_releases" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "merge_releases_repository_idx" ON "merge_releases" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "time_entries_merge_issue_idx" ON "time_entries" USING btree ("merge_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_repositories_webhook_key_idx" ON "merge_repositories" USING btree ("webhook_key") WHERE "merge_repositories"."webhook_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_provider_accounts_login_idx" ON "merge_provider_accounts" USING btree ("provider",coalesce("host", ''),"login");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_provider_accounts_user_idx" ON "merge_provider_accounts" USING btree ("user_id","provider",coalesce("host", ''));