-- WeldMail app-level catch-all: unmatched addresses on a custom domain can be
-- delivered into a designated mailbox. Off by default. Cloudflare zone catch-all
-- (route all mail to the inbound worker) is unchanged.
ALTER TABLE "mail_domains" ADD COLUMN IF NOT EXISTS "catch_all_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN IF NOT EXISTS "catch_all_account_id" varchar(30);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_catch_all_account_id_mail_accounts_id_fk" FOREIGN KEY ("catch_all_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_domains_catch_all_account_id_idx" ON "mail_domains" USING btree ("catch_all_account_id");
