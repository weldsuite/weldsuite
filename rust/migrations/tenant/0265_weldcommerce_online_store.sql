CREATE TABLE "storefront_deployments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"site_id" varchar(30) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"status" varchar(12) DEFAULT 'uploading' NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by" varchar(255),
	"created_by_key_id" varchar(30),
	"promoted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "storefront_menus" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"site_id" varchar(30) NOT NULL,
	"handle" varchar(40) NOT NULL,
	"title" varchar(120) NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"site_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"seo_title" varchar(255),
	"seo_description" varchar(500),
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "storefront_redirects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"site_id" varchar(30) NOT NULL,
	"from_path" varchar(500) NOT NULL,
	"to_path" varchar(1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_site_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"site_id" varchar(30) NOT NULL,
	"number" integer NOT NULL,
	"document" jsonb NOT NULL,
	"note" varchar(500),
	"published_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "storefront_sites" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"channel_id" varchar(30) NOT NULL,
	"mode" varchar(12) DEFAULT 'builder' NOT NULL,
	"locale" varchar(5) DEFAULT 'en' NOT NULL,
	"theme" varchar(40) DEFAULT 'atelier' NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"draft_updated_at" timestamp,
	"published_version_id" varchar(30),
	"published_at" timestamp,
	"active_deployment_id" varchar(30),
	"visibility" varchar(16) DEFAULT 'live' NOT NULL,
	"password_hash" varchar(128),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX "storefront_deployments_site_idx" ON "storefront_deployments" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_menus_site_handle_uidx" ON "storefront_menus" USING btree ("site_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_pages_site_slug_uidx" ON "storefront_pages" USING btree ("site_id","slug") WHERE "storefront_pages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_redirects_site_from_uidx" ON "storefront_redirects" USING btree ("site_id","from_path");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_site_versions_site_number_uidx" ON "storefront_site_versions" USING btree ("site_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_sites_channel_uidx" ON "storefront_sites" USING btree ("channel_id") WHERE "storefront_sites"."deleted_at" IS NULL;