CREATE TABLE "helpcenter_domain_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"domain" varchar(255) NOT NULL,
	"domain_type" varchar(20) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"is_verified" integer DEFAULT 1 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"verification_token" varchar(255),
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "helpcenter_domain_registry_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "helpcenter_domain_registry" ADD CONSTRAINT "helpcenter_domain_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "helpcenter_domain_registry_domain_idx" ON "helpcenter_domain_registry" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "helpcenter_domain_registry_workspace_id_idx" ON "helpcenter_domain_registry" USING btree ("workspace_id");