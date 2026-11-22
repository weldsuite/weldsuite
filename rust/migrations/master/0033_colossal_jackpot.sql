ALTER TABLE "credit_transactions" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_idempotency_key_idx" ON "credit_transactions" USING btree ("idempotency_key");--> statement-breakpoint
-- Prepaid model: plans carry no bundled monthly credits — the wallet is funded
-- purely by prepaid topups. Base subscription fee only.
UPDATE "plans" SET "monthly_credits" = 0;