CREATE TABLE "access_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"requester_id" varchar(255) NOT NULL,
	"permission" varchar(100) NOT NULL,
	"page_label" varchar(120),
	"page_path" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_by" varchar(255),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_requests_status_idx" ON "access_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "access_requests_requester_perm_status_idx" ON "access_requests" USING btree ("requester_id","permission","status");