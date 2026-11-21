CREATE TABLE "telnyx_porting_order_index" (
	"telnyx_porting_order_id" varchar(100) PRIMARY KEY NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"draft_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "telnyx_porting_order_index_org_idx" ON "telnyx_porting_order_index" USING btree ("clerk_org_id");