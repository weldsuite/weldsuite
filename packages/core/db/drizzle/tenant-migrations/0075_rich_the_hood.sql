CREATE TABLE "helpcenter_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"is_enabled" integer DEFAULT 0,
	"site_name" varchar(255),
	"logo" varchar(500),
	"logo_dark" varchar(500),
	"favicon" varchar(500),
	"primary_color" varchar(20),
	"accent_color" varchar(20),
	"hero_title" text,
	"hero_subtitle" text,
	"show_search" integer DEFAULT 1,
	"show_categories" integer DEFAULT 1,
	"meta_title" varchar(255),
	"meta_description" text,
	"og_image" varchar(500),
	"footer_text" text,
	"social_links" jsonb,
	"custom_css" text,
	"google_analytics_id" varchar(50),
	"default_subdomain" varchar(255),
	"custom_domain" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "helpcenter_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"helpcenter_settings_id" varchar(30) NOT NULL,
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
	"ssl_status" varchar(20) DEFAULT 'pending'
);
--> statement-breakpoint
CREATE INDEX "helpcenter_settings_is_enabled_idx" ON "helpcenter_settings" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "helpcenter_domains_settings_idx" ON "helpcenter_domains" USING btree ("helpcenter_settings_id");--> statement-breakpoint
CREATE INDEX "helpcenter_domains_domain_idx" ON "helpcenter_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "helpcenter_domains_is_primary_idx" ON "helpcenter_domains" USING btree ("is_primary");