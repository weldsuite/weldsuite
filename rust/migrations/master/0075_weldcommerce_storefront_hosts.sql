CREATE TABLE "storefront_hosts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"site_id" varchar(30) NOT NULL,
	"kind" varchar(12) DEFAULT 'custom' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"ssl_status" varchar(12),
	"verification_token" varchar(64) NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp,
	"verified_at" timestamp,
	"mode" varchar(12) DEFAULT 'builder' NOT NULL,
	"published_version_id" varchar(30),
	"deployment_id" varchar(30),
	"visibility" varchar(16) DEFAULT 'live' NOT NULL,
	"password_hash" varchar(128),
	"created_by_user_id" varchar(255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_hosts_hostname_uidx" ON "storefront_hosts" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "storefront_hosts_workspace_site_idx" ON "storefront_hosts" USING btree ("workspace_id","site_id");--> statement-breakpoint
CREATE INDEX "storefront_hosts_pending_idx" ON "storefront_hosts" USING btree ("status") WHERE "storefront_hosts"."status" <> 'active';