CREATE TABLE "helpdesk_ticket_types" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(100) NOT NULL,
	"description" varchar(500),
	"icon" varchar(50),
	"color" varchar(20),
	"category" varchar(30) DEFAULT 'customer',
	"fields" jsonb,
	"states" jsonb,
	"disable_ai_autofill" boolean DEFAULT false,
	"default_priority" varchar(20),
	"default_assignee_id" varchar(30),
	"default_department_id" varchar(30),
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN "ticket_type_id" varchar(30);--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_types_active_idx" ON "helpdesk_ticket_types" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "helpdesk_ticket_types_sort_idx" ON "helpdesk_ticket_types" USING btree ("sort_order");