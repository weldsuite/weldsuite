CREATE TABLE "commerce_buyers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"person_id" varchar(30) NOT NULL,
	"company_id" varchar(30) NOT NULL,
	"role" varchar(20) DEFAULT 'buyer' NOT NULL,
	"spend_limit" numeric(18, 2),
	"spend_limit_currency" varchar(3),
	"status" varchar(20) DEFAULT 'invited' NOT NULL,
	"invited_by" varchar(255),
	"invited_at" timestamp,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commerce_company_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"company_id" varchar(30) NOT NULL,
	"approval_threshold" numeric(18, 2),
	"approval_threshold_currency" varchar(3)
);
--> statement-breakpoint
CREATE TABLE "order_approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"reason" varchar(30) DEFAULT 'buyer_limit' NOT NULL,
	"requested_by_person_id" varchar(30),
	"approver_person_id" varchar(30),
	"decision" varchar(20) DEFAULT 'pending' NOT NULL,
	"comment" text,
	"decided_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "guest_access_token_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_buyers_person_company_uidx" ON "commerce_buyers" USING btree ("person_id","company_id") WHERE "commerce_buyers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "commerce_buyers_company_idx" ON "commerce_buyers" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "commerce_buyers_person_idx" ON "commerce_buyers" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_company_settings_company_uidx" ON "commerce_company_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "order_approvals_order_idx" ON "order_approvals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_approvals_approver_idx" ON "order_approvals" USING btree ("approver_person_id");--> statement-breakpoint
CREATE INDEX "order_approvals_decision_idx" ON "order_approvals" USING btree ("decision");--> statement-breakpoint
CREATE UNIQUE INDEX "order_approvals_order_pending_uidx" ON "order_approvals" USING btree ("order_id") WHERE "order_approvals"."decision" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_guest_access_token_uidx" ON "orders" USING btree ("guest_access_token_hash") WHERE "orders"."guest_access_token_hash" IS NOT NULL;