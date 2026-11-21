CREATE TABLE "postpeer_post_index" (
	"postpeer_post_id" varchar(100) PRIMARY KEY NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"social_post_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "postpeer_post_index_org_idx" ON "postpeer_post_index" USING btree ("clerk_org_id");