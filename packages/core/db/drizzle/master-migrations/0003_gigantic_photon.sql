CREATE TABLE "mail_account_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_account_registry_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mail_account_registry" ADD CONSTRAINT "mail_account_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_account_registry_email_idx" ON "mail_account_registry" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mail_account_registry_workspace_id_idx" ON "mail_account_registry" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mail_account_registry_account_id_idx" ON "mail_account_registry" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_account_registry_is_active_idx" ON "mail_account_registry" USING btree ("is_active");