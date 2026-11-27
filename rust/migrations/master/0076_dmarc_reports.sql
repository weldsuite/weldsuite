CREATE TABLE "mail_dmarc_pool_daily" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"pool" varchar(50) NOT NULL,
	"source_ip" varchar(45) NOT NULL,
	"reporter" varchar(255) NOT NULL,
	"header_from_domain" varchar(255) NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"dkim_aligned" integer DEFAULT 0 NOT NULL,
	"spf_aligned" integer DEFAULT 0 NOT NULL,
	"dmarc_pass" integer DEFAULT 0 NOT NULL,
	"disposition_quarantine" integer DEFAULT 0 NOT NULL,
	"disposition_reject" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_dmarc_pool_daily_row_unique" UNIQUE("day","pool","source_ip","reporter","header_from_domain")
);
--> statement-breakpoint
CREATE TABLE "mail_dmarc_report_log" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"reporter_domain" varchar(255) NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"policy_domain" varchar(255) NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"outcome" varchar(30) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_dmarc_report_log_report_unique" UNIQUE("reporter_domain","report_id","policy_domain")
);
--> statement-breakpoint
CREATE TABLE "mail_domain_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"domain" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"mail_domain_id" varchar(30) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domain_registry_domain_workspace_unique" UNIQUE("domain","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "mail_domain_registry" ADD CONSTRAINT "mail_domain_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_dmarc_pool_daily_day_idx" ON "mail_dmarc_pool_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "mail_dmarc_report_log_received_at_idx" ON "mail_dmarc_report_log" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "mail_domain_registry_workspace_id_idx" ON "mail_domain_registry" USING btree ("workspace_id");