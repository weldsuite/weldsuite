CREATE TABLE "partner_contracts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"revenue_share_bps" integer DEFAULT 7500 NOT NULL,
	"base_minimum" numeric(12, 2) DEFAULT '0' NOT NULL,
	"included_credits" integer DEFAULT 0 NOT NULL,
	"credit_floor_price" numeric(12, 6) DEFAULT '0' NOT NULL,
	"extra_credit_price" numeric(12, 6) DEFAULT '0' NOT NULL,
	"allowed_feature_plan_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"past_due_after_days" integer DEFAULT 14 NOT NULL,
	"read_only_after_days" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_credit_grants" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"credits" integer NOT NULL,
	"unit_price" numeric(12, 6) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"credit_transaction_id" varchar(30),
	"granted_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_licence_packages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"allowed_apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_credits" integer DEFAULT 0 NOT NULL,
	"max_seats" integer,
	"feature_plan_id" varchar(30),
	"storage_gb" integer,
	"default_resale_pricing" jsonb NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"user_id" varchar(255),
	"email" varchar(255) NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"invited_by" varchar(255),
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_statement_lines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"statement_id" varchar(30) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"workspace_name" varchar(255) NOT NULL,
	"days_active" integer NOT NULL,
	"days_in_period" integer NOT NULL,
	"seats_billed" integer DEFAULT 0 NOT NULL,
	"resale" numeric(12, 2) NOT NULL,
	"share_amount" numeric(12, 2) NOT NULL,
	"floor_amount" numeric(12, 2) NOT NULL,
	"credit_floor_amount" numeric(12, 2) NOT NULL,
	"extra_credits_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"due" numeric(12, 2) NOT NULL,
	"margin" numeric(12, 2) NOT NULL,
	"breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_statements" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"total_resale" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_due" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_margin" numeric(12, 2) DEFAULT '0' NOT NULL,
	"stripe_invoice_id" varchar(255),
	"stripe_invoice_url" text,
	"stripe_invoice_pdf" text,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"contract_snapshot" jsonb NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_statements_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "partner_territories" (
	"country_code" varchar(2) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_workspace_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"requester_user_id" varchar(255),
	"requester_email" varchar(255) NOT NULL,
	"requester_name" varchar(255),
	"company_name" varchar(255) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"selected_apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"workspace_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"legal_name" varchar(255),
	"country" varchar(2),
	"tax_id" varchar(100),
	"billing_email" varchar(255) NOT NULL,
	"support_email" varchar(255),
	"support_url" varchar(500),
	"website_url" varchar(500),
	"logo_url" varchar(500),
	"stripe_customer_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"dunning_paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_licence_changes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by" varchar(255),
	"changed_by_type" varchar(20) NOT NULL,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_licences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"partner_id" varchar(30) NOT NULL,
	"package_id" varchar(30),
	"allowed_apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_credits" integer DEFAULT 0 NOT NULL,
	"credit_rollover_cap" integer DEFAULT 0 NOT NULL,
	"max_seats" integer,
	"feature_plan_id" varchar(30),
	"storage_gb" integer,
	"resale_pricing" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_licences_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_seat_snapshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"date" varchar(10) NOT NULL,
	"active_members" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "partner_id" varchar(30);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_mode" varchar(20) DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_grants" ADD CONSTRAINT "partner_credit_grants_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_licence_packages" ADD CONSTRAINT "partner_licence_packages_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_statement_lines" ADD CONSTRAINT "partner_statement_lines_statement_id_partner_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."partner_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_territories" ADD CONSTRAINT "partner_territories_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_workspace_requests" ADD CONSTRAINT "partner_workspace_requests_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_licences" ADD CONSTRAINT "workspace_licences_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_contracts_partner_idx" ON "partner_contracts" USING btree ("partner_id","effective_from");--> statement-breakpoint
CREATE INDEX "partner_credit_grants_partner_idx" ON "partner_credit_grants" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE INDEX "partner_licence_packages_partner_idx" ON "partner_licence_packages" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_members_partner_email_uidx" ON "partner_members" USING btree ("partner_id","email");--> statement-breakpoint
CREATE INDEX "partner_members_user_idx" ON "partner_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "partner_members_email_idx" ON "partner_members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "partner_statement_lines_statement_idx" ON "partner_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_statements_partner_period_uidx" ON "partner_statements" USING btree ("partner_id","period_start");--> statement-breakpoint
CREATE INDEX "partner_statements_status_idx" ON "partner_statements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "partner_territories_partner_idx" ON "partner_territories" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_workspace_requests_partner_idx" ON "partner_workspace_requests" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "partners_status_idx" ON "partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workspace_licence_changes_ws_idx" ON "workspace_licence_changes" USING btree ("workspace_id","changed_at");--> statement-breakpoint
CREATE INDEX "workspace_licence_changes_partner_idx" ON "workspace_licence_changes" USING btree ("partner_id","changed_at");--> statement-breakpoint
CREATE INDEX "workspace_licences_partner_idx" ON "workspace_licences" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_seat_snapshots_ws_date_uidx" ON "workspace_seat_snapshots" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE INDEX "workspaces_partner_id_idx" ON "workspaces" USING btree ("partner_id");