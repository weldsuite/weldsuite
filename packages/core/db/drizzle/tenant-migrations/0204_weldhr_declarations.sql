CREATE TABLE "hr_declarations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"expense_date" date NOT NULL,
	"category" varchar(30) DEFAULT 'other' NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"receipt_file_key" varchar(500),
	"receipt_file_name" varchar(255),
	"receipt_content_type" varchar(120),
	"receipt_size" integer,
	"submitted_by" varchar(255),
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp,
	"review_note" text,
	"paid_by" varchar(255),
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_portal_settings" ADD COLUMN "employee_declarations" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "hr_declarations_employee_idx" ON "hr_declarations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_declarations_status_idx" ON "hr_declarations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hr_declarations_expense_date_idx" ON "hr_declarations" USING btree ("expense_date");