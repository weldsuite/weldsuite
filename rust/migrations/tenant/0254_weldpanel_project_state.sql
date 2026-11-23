CREATE TABLE "panel_erased_ids" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"erased_id" text NOT NULL,
	"erased_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_group_slots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"group_type" varchar(32) NOT NULL,
	"position" integer NOT NULL,
	"taken_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_groups" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"group_type" varchar(32) NOT NULL,
	"group_key" varchar(255) NOT NULL,
	"properties" json NOT NULL,
	"first_seen" timestamp (3) with time zone NOT NULL,
	"last_seen" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_identity_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"anon_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ts" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_people" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"user_id" text NOT NULL,
	"email" varchar(320),
	"name" text,
	"properties" json NOT NULL,
	"first_seen" timestamp (3) with time zone NOT NULL,
	"last_seen" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_project_meta" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"applied_stream" varchar(255),
	"applied_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "panel_erased_ids_id_idx" ON "panel_erased_ids" USING btree ("workspace_id","project_id","erased_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_group_slots_type_idx" ON "panel_group_slots" USING btree ("workspace_id","project_id","group_type");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_groups_key_idx" ON "panel_groups" USING btree ("workspace_id","project_id","group_type","group_key");--> statement-breakpoint
CREATE INDEX "panel_groups_last_seen_idx" ON "panel_groups" USING btree ("workspace_id","project_id","group_type","last_seen" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "panel_identity_links_anon_idx" ON "panel_identity_links" USING btree ("workspace_id","project_id","anon_id");--> statement-breakpoint
CREATE INDEX "panel_identity_links_user_idx" ON "panel_identity_links" USING btree ("workspace_id","project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_people_user_idx" ON "panel_people" USING btree ("workspace_id","project_id","user_id");--> statement-breakpoint
CREATE INDEX "panel_people_last_seen_idx" ON "panel_people" USING btree ("workspace_id","project_id","last_seen" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "panel_people_email_idx" ON "panel_people" USING btree ("workspace_id","project_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_project_meta_project_idx" ON "panel_project_meta" USING btree ("workspace_id","project_id");