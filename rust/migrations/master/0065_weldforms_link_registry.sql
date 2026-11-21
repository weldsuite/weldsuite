CREATE TABLE "form_abuse_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"public_id" varchar(20) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"reason" varchar(30) NOT NULL,
	"details" text,
	"reporter_email" varchar(320),
	"reporter_ip_hash" varchar(64),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"resolved_by" varchar(255),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_invitation_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"invitation_id" varchar(30) NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_link_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"public_id" varchar(20) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"form_id" varchar(30) NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"held_at" timestamp with time zone,
	"held_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "form_abuse_reports_status_idx" ON "form_abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "form_abuse_reports_public_id_idx" ON "form_abuse_reports" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_invitation_registry_token_idx" ON "form_invitation_registry" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "form_invitation_registry_invitation_idx" ON "form_invitation_registry" USING btree ("workspace_id","invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_link_registry_public_id_idx" ON "form_link_registry" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "form_link_registry_form_idx" ON "form_link_registry" USING btree ("workspace_id","form_id");