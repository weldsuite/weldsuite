CREATE TABLE "weldpass_item_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"item_id" varchar(30) NOT NULL,
	"vault_id" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"action" varchar(20) NOT NULL,
	"ciphertext" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldpass_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"vault_id" varchar(30) NOT NULL,
	"type" varchar(20) NOT NULL,
	"title" varchar(200) NOT NULL,
	"subtitle" varchar(255),
	"url" text,
	"host" varchar(255),
	"has_totp" boolean DEFAULT false NOT NULL,
	"ciphertext" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(255),
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weldpass_vault_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"vault_id" varchar(30) NOT NULL,
	"item_id" varchar(30),
	"actor_id" varchar(255) NOT NULL,
	"action" varchar(40) NOT NULL,
	"target_label" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldpass_vault_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"vault_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) NOT NULL,
	"added_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldpass_vaults" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"owner_id" varchar(255),
	"name" varchar(100) NOT NULL,
	"description" text,
	"kek_wrapped" text NOT NULL,
	"root_key_version" varchar(10) DEFAULT 'v1' NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "weldpass_item_versions_item_idx" ON "weldpass_item_versions" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weldpass_item_versions_item_version_idx" ON "weldpass_item_versions" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX "weldpass_items_vault_idx" ON "weldpass_items" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "weldpass_items_host_idx" ON "weldpass_items" USING btree ("host");--> statement-breakpoint
CREATE INDEX "weldpass_vault_events_vault_idx" ON "weldpass_vault_events" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "weldpass_vault_events_item_idx" ON "weldpass_vault_events" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "weldpass_vault_events_created_at_idx" ON "weldpass_vault_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weldpass_vault_members_vault_user_idx" ON "weldpass_vault_members" USING btree ("vault_id","user_id");--> statement-breakpoint
CREATE INDEX "weldpass_vault_members_user_idx" ON "weldpass_vault_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "weldpass_vaults_workspace_idx" ON "weldpass_vaults" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weldpass_vaults_personal_owner_idx" ON "weldpass_vaults" USING btree ("workspace_id","owner_id") WHERE "weldpass_vaults"."kind" = 'personal' AND "weldpass_vaults"."deleted_at" IS NULL;