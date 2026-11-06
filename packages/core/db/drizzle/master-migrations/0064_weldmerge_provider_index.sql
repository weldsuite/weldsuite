CREATE TABLE "merge_provider_index" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"provider" varchar(20) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"external_key" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "merge_provider_index_key_uidx" ON "merge_provider_index" USING btree ("provider","kind","external_key");--> statement-breakpoint
CREATE INDEX "merge_provider_index_workspace_idx" ON "merge_provider_index" USING btree ("workspace_id");