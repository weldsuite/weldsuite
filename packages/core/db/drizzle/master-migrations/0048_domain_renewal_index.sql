CREATE TABLE "domain_renewal_index" (
	"clerk_org_id" varchar(255) PRIMARY KEY NOT NULL,
	"next_due_at" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "domain_renewal_index_due_idx" ON "domain_renewal_index" USING btree ("next_due_at");
