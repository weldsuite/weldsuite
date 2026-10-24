CREATE TABLE "sign_link_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"recipient_id" varchar(30) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sign_link_registry_token_idx" ON "sign_link_registry" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sign_link_registry_envelope_idx" ON "sign_link_registry" USING btree ("workspace_id","envelope_id");