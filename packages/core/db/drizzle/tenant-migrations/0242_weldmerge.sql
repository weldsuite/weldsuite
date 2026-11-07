CREATE TABLE "merge_comments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"issue_id" varchar(30) NOT NULL,
	"author_user_id" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_account_id" varchar(255) NOT NULL,
	"account_login" varchar(255),
	"account_type" varchar(30),
	"host" varchar(500),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"credentials" text,
	"credentials_expire_at" timestamp with time zone,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_cycles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"team_id" varchar(30) NOT NULL,
	"number" integer NOT NULL,
	"name" varchar(255),
	"starts_at" date NOT NULL,
	"ends_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_issue_pull_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"issue_id" varchar(30) NOT NULL,
	"pull_request_id" varchar(30) NOT NULL,
	"source" varchar(10) NOT NULL,
	"closes" boolean DEFAULT true NOT NULL,
	"created_by_user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_issues" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"team_id" varchar(30) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_user_id" varchar(255),
	"creator_user_id" varchar(255) NOT NULL,
	"cycle_id" varchar(30),
	"parent_issue_id" varchar(30),
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimate" integer,
	"due_date" date,
	"flow_project_id" varchar(30),
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_labels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"team_id" varchar(30),
	"name" varchar(100) NOT NULL,
	"color" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_provider_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"login" varchar(255) NOT NULL,
	"external_user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_pull_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"repository_id" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(1000) NOT NULL,
	"body" text,
	"state" varchar(20) NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"url" varchar(1000) NOT NULL,
	"author_login" varchar(255),
	"author_avatar_url" varchar(1000),
	"author_user_id" varchar(255),
	"head_ref" varchar(500),
	"base_ref" varchar(500),
	"head_sha" varchar(64),
	"additions" integer,
	"deletions" integer,
	"changed_files" integer,
	"checks_status" varchar(20),
	"review_decision" varchar(30),
	"requested_reviewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_repositories" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"full_name" varchar(500) NOT NULL,
	"default_branch" varchar(255),
	"private" boolean DEFAULT true NOT NULL,
	"url" varchar(1000),
	"team_id" varchar(30),
	"issue_sync" varchar(20) DEFAULT 'off' NOT NULL,
	"pr_sync" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merge_teams" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"color" varchar(20),
	"issue_counter" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "merge_comments_issue_idx" ON "merge_comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_connections_account_idx" ON "merge_connections" USING btree ("provider","external_account_id") WHERE "merge_connections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_cycles_team_number_idx" ON "merge_cycles" USING btree ("team_id","number") WHERE "merge_cycles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_issue_pull_requests_pair_idx" ON "merge_issue_pull_requests" USING btree ("issue_id","pull_request_id");--> statement-breakpoint
CREATE INDEX "merge_issue_pull_requests_pr_idx" ON "merge_issue_pull_requests" USING btree ("pull_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_issues_team_number_idx" ON "merge_issues" USING btree ("team_id","number");--> statement-breakpoint
CREATE INDEX "merge_issues_team_status_idx" ON "merge_issues" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "merge_issues_assignee_idx" ON "merge_issues" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "merge_issues_cycle_idx" ON "merge_issues" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "merge_issues_parent_idx" ON "merge_issues" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX "merge_issues_updated_idx" ON "merge_issues" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "merge_labels_team_idx" ON "merge_labels" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_provider_accounts_login_idx" ON "merge_provider_accounts" USING btree ("provider","login");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_provider_accounts_user_idx" ON "merge_provider_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_pull_requests_repo_number_idx" ON "merge_pull_requests" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "merge_pull_requests_state_idx" ON "merge_pull_requests" USING btree ("state","provider_updated_at");--> statement-breakpoint
CREATE INDEX "merge_pull_requests_author_idx" ON "merge_pull_requests" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_repositories_external_idx" ON "merge_repositories" USING btree ("connection_id","external_id") WHERE "merge_repositories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "merge_repositories_external_lookup_idx" ON "merge_repositories" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_teams_key_idx" ON "merge_teams" USING btree ("key") WHERE "merge_teams"."deleted_at" IS NULL;