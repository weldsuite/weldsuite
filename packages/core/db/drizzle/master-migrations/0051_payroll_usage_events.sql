CREATE TABLE "payroll_usage_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"month" varchar(7) NOT NULL,
	"country" varchar(2) NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"run_id" varchar(30) NOT NULL,
	"payslip_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_usage_events_payslip_uidx" ON "payroll_usage_events" USING btree ("workspace_id","payslip_id");--> statement-breakpoint
CREATE INDEX "payroll_usage_events_month_idx" ON "payroll_usage_events" USING btree ("workspace_id","month");