CREATE TABLE "companies" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"name" varchar(255) NOT NULL,
	"trading_name" varchar(255),
	"display_name" varchar(255) NOT NULL,
	"registration_number" varchar(100),
	"vat_number" varchar(50),
	"industry" varchar(100),
	"employee_count" varchar(50),
	"annual_revenue" jsonb,
	"website" varchar(500),
	"email" varchar(255),
	"alternate_emails" jsonb,
	"phone" varchar(50),
	"mobile" varchar(50),
	"fax" varchar(50),
	"primary_address" jsonb,
	"addresses" jsonb,
	"avatar_url" varchar(1000),
	"linkedin_url" varchar(500),
	"twitter_handle" varchar(100),
	"facebook_url" varchar(500),
	"owner_id" varchar(255),
	"account_manager_id" varchar(255),
	"status" varchar(20) DEFAULT 'prospect' NOT NULL,
	"lifecycle_stage" varchar(30),
	"segment" varchar(50),
	"rating" varchar(10),
	"source" varchar(100),
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"lead_score" integer DEFAULT 0,
	"nps_score" integer,
	"satisfaction_score" integer,
	"first_contact_date" timestamp,
	"last_contact_date" timestamp,
	"next_follow_up_date" timestamp,
	"preferred_contact_method" varchar(20),
	"preferred_language" varchar(10),
	"timezone" varchar(50),
	"marketing_consent" boolean DEFAULT false,
	"email_opt_in" boolean DEFAULT false,
	"sms_opt_in" boolean DEFAULT false,
	"do_not_call" boolean DEFAULT false,
	"tags" jsonb,
	"custom_fields" jsonb,
	"notes" text,
	"internal_notes" text,
	"party_code" varchar(50),
	"archived_at" timestamp,
	CONSTRAINT "companies_party_code_unique" UNIQUE("party_code")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"full_name" varchar(255),
	"display_name" varchar(255) NOT NULL,
	"date_of_birth" timestamp,
	"gender" varchar(20),
	"title" varchar(100),
	"department" varchar(100),
	"role" varchar(30),
	"email" varchar(255),
	"alternate_emails" jsonb,
	"direct_phone" varchar(50),
	"mobile_phone" varchar(50),
	"extension" varchar(20),
	"primary_address" jsonb,
	"addresses" jsonb,
	"avatar_url" varchar(1000),
	"linkedin_url" varchar(500),
	"twitter_handle" varchar(100),
	"owner_id" varchar(255),
	"account_manager_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"lifecycle_stage" varchar(30),
	"rating" varchar(10),
	"source" varchar(100),
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_decision_maker" boolean DEFAULT false,
	"is_billing_contact" boolean DEFAULT false,
	"is_technical_contact" boolean DEFAULT false,
	"influence_level" varchar(10),
	"lead_score" integer DEFAULT 0,
	"nps_score" integer,
	"satisfaction_score" integer,
	"first_contact_date" timestamp,
	"last_contact_date" timestamp,
	"last_contacted_at" timestamp,
	"next_follow_up_date" timestamp,
	"last_activity_type" varchar(50),
	"preferred_contact_method" varchar(20),
	"preferred_language" varchar(10),
	"best_time_to_contact" varchar(100),
	"marketing_consent" boolean DEFAULT false,
	"email_opt_in" boolean DEFAULT false,
	"sms_opt_in" boolean DEFAULT false,
	"do_not_call" boolean DEFAULT false,
	"tags" jsonb,
	"interests" jsonb,
	"custom_fields" jsonb,
	"notes" text,
	"internal_notes" text,
	"party_code" varchar(50),
	"visitor_id" varchar(100),
	"archived_at" timestamp,
	CONSTRAINT "people_party_code_unique" UNIQUE("party_code"),
	CONSTRAINT "people_visitor_id_unique" UNIQUE("visitor_id")
);
--> statement-breakpoint
CREATE TABLE "person_companies" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"person_id" varchar(30) NOT NULL,
	"company_id" varchar(30) NOT NULL,
	"role" varchar(50),
	"is_primary" boolean DEFAULT false NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "list_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"added_by" varchar(255),
	"list_id" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"color" varchar(50) DEFAULT 'bg-blue-500' NOT NULL,
	"icon" varchar(100) DEFAULT 'List' NOT NULL,
	"kind" varchar(10) NOT NULL,
	"type" varchar(10) DEFAULT 'static' NOT NULL,
	"filter_rules" jsonb,
	"linked_list_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "agent_packages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" varchar(50) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"stripe_price_id" text,
	"session_token_limit" integer NOT NULL,
	"weekly_token_limit" integer NOT NULL,
	"token_multiplier" numeric(5, 2) DEFAULT '1.00' NOT NULL,
	"default_model_id" varchar(100) DEFAULT 'claude-opus-4-7' NOT NULL,
	"default_system_prompt" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_contacts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"email" varchar(255),
	"phone" varchar(50),
	"tax_number" varchar(50),
	"kvk_number" varchar(20),
	"iban" varchar(34),
	"bic" varchar(11),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"payment_terms_days" integer DEFAULT 30,
	"currency" varchar(3) DEFAULT 'EUR',
	"default_revenue_account_id" varchar(30),
	"default_expense_account_id" varchar(30),
	"crm_customer_id" varchar(30),
	"crm_contact_id" varchar(30),
	"credit_limit" numeric(18, 2),
	"outstanding_balance" numeric(18, 2) DEFAULT '0',
	"notes" text,
	"tags" jsonb,
	"sepa_mandate" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "kind" varchar(10);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "company_id" varchar(30);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "converted_to_counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "person_ids" jsonb;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "primary_person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_quotes" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "crm_quotes" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "meeting_bot_sessions" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "meeting_bot_sessions" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "commerce_carts" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "commerce_carts" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "commerce_discount_usage" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "commerce_discounts" ADD COLUMN "counterparty_ids" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_satisfaction_surveys" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "matched_counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "meeting_session_waitlist" ADD COLUMN "counterparty_id" varchar(30);--> statement-breakpoint
ALTER TABLE "meeting_session_waitlist" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
CREATE INDEX "companies_email_idx" ON "companies" USING btree ("email");--> statement-breakpoint
CREATE INDEX "companies_display_name_idx" ON "companies" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX "companies_status_idx" ON "companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "companies_owner_idx" ON "companies" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "companies_party_code_idx" ON "companies" USING btree ("party_code");--> statement-breakpoint
CREATE INDEX "companies_deleted_at_idx" ON "companies" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "companies_is_customer_idx" ON "companies" USING btree ("is_customer");--> statement-breakpoint
CREATE INDEX "companies_is_supplier_idx" ON "companies" USING btree ("is_supplier");--> statement-breakpoint
CREATE INDEX "companies_is_lead_idx" ON "companies" USING btree ("is_lead");--> statement-breakpoint
CREATE INDEX "people_email_idx" ON "people" USING btree ("email");--> statement-breakpoint
CREATE INDEX "people_display_name_idx" ON "people" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX "people_status_idx" ON "people" USING btree ("status");--> statement-breakpoint
CREATE INDEX "people_owner_idx" ON "people" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "people_party_code_idx" ON "people" USING btree ("party_code");--> statement-breakpoint
CREATE INDEX "people_deleted_at_idx" ON "people" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "people_is_customer_idx" ON "people" USING btree ("is_customer");--> statement-breakpoint
CREATE INDEX "people_is_supplier_idx" ON "people" USING btree ("is_supplier");--> statement-breakpoint
CREATE INDEX "people_is_lead_idx" ON "people" USING btree ("is_lead");--> statement-breakpoint
CREATE INDEX "people_visitor_id_idx" ON "people" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "person_companies_person_idx" ON "person_companies" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_companies_company_idx" ON "person_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "person_companies_primary_idx" ON "person_companies" USING btree ("is_primary");--> statement-breakpoint
CREATE UNIQUE INDEX "person_companies_unique_stint" ON "person_companies" USING btree ("person_id","company_id","started_at");--> statement-breakpoint
CREATE INDEX "list_members_list_idx" ON "list_members" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "list_members_entity_idx" ON "list_members" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "list_members_unique" ON "list_members" USING btree ("list_id","entity_id");--> statement-breakpoint
CREATE INDEX "lists_name_idx" ON "lists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "lists_kind_idx" ON "lists" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "lists_deleted_at_idx" ON "lists" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_packages_slug_unique" ON "agent_packages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agent_packages_is_active_idx" ON "agent_packages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "agent_packages_is_default_idx" ON "agent_packages" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "acct_contacts_type_idx" ON "accounting_contacts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "acct_contacts_name_idx" ON "accounting_contacts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "acct_contacts_email_idx" ON "accounting_contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "acct_contacts_crm_customer_idx" ON "accounting_contacts" USING btree ("crm_customer_id");--> statement-breakpoint
CREATE INDEX "acct_contacts_tax_number_idx" ON "accounting_contacts" USING btree ("tax_number");--> statement-breakpoint
CREATE INDEX "acct_contacts_iban_idx" ON "accounting_contacts" USING btree ("iban");--> statement-breakpoint
CREATE INDEX "projects_counterparty_idx" ON "projects" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "tasks_counterparty_idx" ON "tasks" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "tasks_person_idx" ON "tasks" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "parties_kind_idx" ON "parties" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "parties_company_id_idx" ON "parties" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "parties_person_id_idx" ON "parties" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "parties_display_name_idx" ON "parties" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX "orders_counterparty_idx" ON "orders" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "orders_person_idx" ON "orders" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_counterparty_idx" ON "crm_opportunities" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_primary_person_idx" ON "crm_opportunities" USING btree ("primary_person_id");--> statement-breakpoint
CREATE INDEX "crm_activities_counterparty_idx" ON "crm_activities" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "crm_activities_person_idx" ON "crm_activities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "crm_quotes_counterparty_idx" ON "crm_quotes" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "crm_quotes_person_idx" ON "crm_quotes" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_counterparty_idx" ON "sequence_enrollments" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_counterparty_idx" ON "meeting_bot_sessions" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_sessions_person_idx" ON "meeting_bot_sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "commerce_carts_counterparty_idx" ON "commerce_carts" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "commerce_discount_usage_counterparty_idx" ON "commerce_discount_usage" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_counterparty_idx" ON "helpdesk_conversations" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_person_idx" ON "helpdesk_conversations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_counterparty_idx" ON "helpdesk_tickets" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_person_idx" ON "helpdesk_tickets" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "helpdesk_satisfaction_surveys_counterparty_idx" ON "helpdesk_satisfaction_surveys" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "acct_invoices_counterparty_idx" ON "invoices" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "acct_invoices_person_idx" ON "invoices" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "acct_bills_counterparty_idx" ON "bills" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "acct_bills_person_idx" ON "bills" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "acct_documents_matched_counterparty_idx" ON "documents" USING btree ("matched_counterparty_id");--> statement-breakpoint
CREATE INDEX "acct_payments_counterparty_idx" ON "payments" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "acct_payments_person_idx" ON "payments" USING btree ("person_id");