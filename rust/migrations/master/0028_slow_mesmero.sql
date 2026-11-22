ALTER TABLE "app_catalog" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_catalog" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_catalog" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "app_catalog" ADD COLUMN "documentation_url" text;--> statement-breakpoint
ALTER TABLE "app_catalog" ADD COLUMN "contact_url" text;