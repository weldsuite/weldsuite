CREATE TABLE "forms_custom_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"ssl_status" varchar(12),
	"verification_token" varchar(64) NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp,
	"verified_at" timestamp,
	"home_form_public_id" varchar(20),
	"created_by_user_id" varchar(255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "forms_custom_domains_hostname_uidx" ON "forms_custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "forms_custom_domains_workspace_idx" ON "forms_custom_domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "forms_custom_domains_pending_idx" ON "forms_custom_domains" USING btree ("status") WHERE "forms_custom_domains"."status" <> 'active';