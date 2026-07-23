CREATE TABLE "digest_schedules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"send_hour" integer DEFAULT 8 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digest_schedules" ADD CONSTRAINT "digest_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_schedules_workspace_id_idx" ON "digest_schedules" USING btree ("workspace_id");