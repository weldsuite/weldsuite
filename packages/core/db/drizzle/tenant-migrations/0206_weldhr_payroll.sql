CREATE TABLE "hr_compensations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"pay_type" varchar(10) NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"period" varchar(10) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"hours_per_week" double precision,
	"reason" text,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_pay_components" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"code" varchar(60) NOT NULL,
	"label" varchar(160),
	"amount" numeric(14, 2),
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_pay_run_inputs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"run_id" varchar(30) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"code" varchar(60) NOT NULL,
	"label" varchar(160),
	"quantity" numeric(12, 4),
	"rate" numeric(14, 4),
	"amount" numeric(14, 2),
	"work_date" date,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"source_ref" varchar(30),
	"notes" text,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_pay_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"pay_schedule_id" varchar(30),
	"country" varchar(2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"kind" varchar(20) DEFAULT 'regular' NOT NULL,
	"corrects_run_id" varchar(30),
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"tax_year" integer NOT NULL,
	"period_number" integer NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"excluded_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"included_employee_ids" jsonb,
	"totals" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"prepared_by" varchar(255),
	"calculated_by" varchar(255),
	"calculated_at" timestamp,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"paid_by" varchar(255),
	"paid_at" timestamp,
	"cancelled_at" timestamp,
	"journal_status" varchar(20) DEFAULT 'not_linked' NOT NULL,
	"journal_entry_id" varchar(30),
	"journal_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_pay_schedules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"name" varchar(120) NOT NULL,
	"frequency" varchar(20) NOT NULL,
	"anchor_date" date NOT NULL,
	"pay_date_rule" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_employers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"legal_name" varchar(255) NOT NULL,
	"country" varchar(2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"accounting_entity_id" varchar(30),
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nl_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"us_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bank_encrypted" text,
	"require_separate_approver" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_filings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"country" varchar(2) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"state" varchar(2),
	"tax_year" integer NOT NULL,
	"period" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_due" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_reference" varchar(40),
	"file_key" varchar(500),
	"file_name" varchar(255),
	"content_type" varchar(120),
	"generated_at" timestamp,
	"channel" varchar(20),
	"external_reference" varchar(120),
	"submitted_by" varchar(255),
	"submitted_at" timestamp,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_profiles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"pay_schedule_id" varchar(30),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"start_date" date,
	"end_date" date,
	"nl" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"us" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payslips" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"run_id" varchar(30) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"employer_id" varchar(30) NOT NULL,
	"country" varchar(2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"number" varchar(30),
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"tax_year" integer NOT NULL,
	"period_number" integer NOT NULL,
	"gross_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
	"taxable_wage" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employee_taxes" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employee_deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"reimbursements" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employer_taxes" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employer_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ytd" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filing_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"corrects_payslip_id" varchar(30),
	"file_key" varchar(500),
	"employee_viewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_tax_elections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"kind" varchar(30) NOT NULL,
	"state" varchar(2),
	"effective_from" date NOT NULL,
	"data" jsonb NOT NULL,
	"signed_by" varchar(255),
	"signature_name" varchar(255),
	"signed_at" timestamp,
	"source" varchar(20) DEFAULT 'admin' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_compensations_employee_idx" ON "hr_compensations" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "hr_pay_components_employee_idx" ON "hr_pay_components" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_pay_run_inputs_run_idx" ON "hr_pay_run_inputs" USING btree ("run_id","employee_id");--> statement-breakpoint
CREATE INDEX "hr_pay_run_inputs_source_idx" ON "hr_pay_run_inputs" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "hr_pay_runs_employer_period_idx" ON "hr_pay_runs" USING btree ("employer_id","period_start");--> statement-breakpoint
CREATE INDEX "hr_pay_runs_status_idx" ON "hr_pay_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_pay_runs_regular_uidx" ON "hr_pay_runs" USING btree ("pay_schedule_id","period_start") WHERE kind = 'regular' AND status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "hr_pay_schedules_employer_idx" ON "hr_pay_schedules" USING btree ("employer_id");--> statement-breakpoint
CREATE INDEX "hr_payroll_employers_country_idx" ON "hr_payroll_employers" USING btree ("country");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payroll_filings_period_uidx" ON "hr_payroll_filings" USING btree ("employer_id","kind","tax_year","period",coalesce("state", ''));--> statement-breakpoint
CREATE INDEX "hr_payroll_filings_status_idx" ON "hr_payroll_filings" USING btree ("status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payroll_profiles_employee_uidx" ON "hr_payroll_profiles" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_payroll_profiles_employer_idx" ON "hr_payroll_profiles" USING btree ("employer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payslips_run_employee_uidx" ON "hr_payslips" USING btree ("run_id","employee_id");--> statement-breakpoint
CREATE INDEX "hr_payslips_employee_idx" ON "hr_payslips" USING btree ("employee_id","pay_date");--> statement-breakpoint
CREATE INDEX "hr_payslips_employer_year_idx" ON "hr_payslips" USING btree ("employer_id","tax_year");--> statement-breakpoint
CREATE INDEX "hr_tax_elections_employee_idx" ON "hr_tax_elections" USING btree ("employee_id","kind","effective_from");