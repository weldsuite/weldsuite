ALTER TABLE "workspace_agent_purchases" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_agents_subscription_id" varchar(255);--> statement-breakpoint
CREATE INDEX "wap_sub_item_idx" ON "workspace_agent_purchases" USING btree ("stripe_subscription_item_id");