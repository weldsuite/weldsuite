ALTER TABLE "mail_accounts" ADD COLUMN "assigned_user_ids" jsonb;
--> statement-breakpoint
UPDATE mail_accounts SET is_shared = true WHERE is_shared IS NULL OR is_shared = false;