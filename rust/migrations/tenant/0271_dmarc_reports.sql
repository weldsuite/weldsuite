CREATE TABLE "mail_dmarc_records" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"report_id" varchar(30) NOT NULL,
	"mail_domain_id" varchar(30) NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"source_ip" varchar(45) NOT NULL,
	"source_name" varchar(255),
	"weldsuite_pool" varchar(50),
	"count" integer NOT NULL,
	"disposition" varchar(20) NOT NULL,
	"dkim_aligned" boolean NOT NULL,
	"spf_aligned" boolean NOT NULL,
	"header_from" varchar(255) NOT NULL,
	"envelope_from" varchar(255),
	"dkim_results" jsonb,
	"spf_results" jsonb,
	"reasons" jsonb
);
--> statement-breakpoint
CREATE TABLE "mail_dmarc_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"mail_domain_id" varchar(30) NOT NULL,
	"domain_name" varchar(255) NOT NULL,
	"reporter_org" varchar(255) NOT NULL,
	"reporter_email" varchar(255) NOT NULL,
	"reporter_domain" varchar(255) NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"policy_domain" varchar(255) NOT NULL,
	"policy" jsonb,
	"authenticated" boolean DEFAULT false NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_dmarc_reports_report_unique" UNIQUE("mail_domain_id","reporter_domain","report_id")
);
--> statement-breakpoint
CREATE TABLE "mail_dmarc_sources" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"mail_domain_id" varchar(30) NOT NULL,
	"source_key" varchar(255) NOT NULL,
	"mark" varchar(20) NOT NULL,
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_dmarc_sources_domain_key_unique" UNIQUE("mail_domain_id","source_key")
);
--> statement-breakpoint
ALTER TABLE "mail_dmarc_records" ADD CONSTRAINT "mail_dmarc_records_report_id_mail_dmarc_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."mail_dmarc_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_dmarc_records_domain_period_idx" ON "mail_dmarc_records" USING btree ("mail_domain_id","period_end");--> statement-breakpoint
CREATE INDEX "mail_dmarc_records_report_idx" ON "mail_dmarc_records" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "mail_dmarc_reports_domain_period_idx" ON "mail_dmarc_reports" USING btree ("mail_domain_id","period_end");