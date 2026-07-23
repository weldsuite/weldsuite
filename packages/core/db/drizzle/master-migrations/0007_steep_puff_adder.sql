CREATE TABLE "api_key_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_type" varchar(20) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"tenant_key_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key_registry" ADD CONSTRAINT "api_key_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_registry_key_hash_idx" ON "api_key_registry" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_key_registry_workspace_id_idx" ON "api_key_registry" USING btree ("workspace_id");