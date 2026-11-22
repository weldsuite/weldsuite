CREATE TABLE "annual_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"size_class" varchar(10) NOT NULL,
	"status" varchar(15) DEFAULT 'draft' NOT NULL,
	"figures" jsonb,
	"disclosures" jsonb,
	"adopted" boolean DEFAULT false NOT NULL,
	"adoption_date" timestamp,
	"xml_content" text,
	"filing_reference" varchar(255),
	"digipoort_response" jsonb,
	"filed_at" timestamp,
	"filed_by" varchar(255),
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"created_by" varchar(255),
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "annual_reports_entity_year_idx" ON "annual_reports" USING btree ("entity_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "annual_reports_status_idx" ON "annual_reports" USING btree ("status");