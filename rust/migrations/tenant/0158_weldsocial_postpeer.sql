ALTER TABLE "social_accounts" ADD COLUMN "postpeer_integration_id" varchar(255);--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "postpeer_profile_id" varchar(255);--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "postpeer_post_id" varchar(255);--> statement-breakpoint
CREATE INDEX "social_accounts_postpeer_integration_idx" ON "social_accounts" USING btree ("postpeer_integration_id");--> statement-breakpoint
CREATE INDEX "social_posts_postpeer_post_idx" ON "social_posts" USING btree ("postpeer_post_id");
