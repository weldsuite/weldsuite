CREATE TABLE IF NOT EXISTS "personal_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"clerk_user_id" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"plan_id" varchar(30),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_account_registry" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_account_registry" ADD COLUMN IF NOT EXISTS "tenant_kind" varchar(20) DEFAULT 'workspace' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_account_registry" ADD COLUMN IF NOT EXISTS "personal_account_id" varchar(30);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_accounts_clerk_user_id_idx" ON "personal_accounts" USING btree ("clerk_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_accounts_is_active_idx" ON "personal_accounts" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_account_registry_personal_account_id_idx" ON "mail_account_registry" USING btree ("personal_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_account_registry_tenant_kind_idx" ON "mail_account_registry" USING btree ("tenant_kind");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "personal_accounts" ADD CONSTRAINT "personal_accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_account_registry" ADD CONSTRAINT "mail_account_registry_personal_account_id_personal_accounts_id_fk" FOREIGN KEY ("personal_account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_account_registry" ADD CONSTRAINT "mail_account_registry_tenant_check" CHECK ((
  (tenant_kind = 'workspace' AND workspace_id IS NOT NULL AND personal_account_id IS NULL)
  OR (tenant_kind = 'personal' AND personal_account_id IS NOT NULL AND workspace_id IS NULL)
 ));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
