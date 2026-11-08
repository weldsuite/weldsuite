CREATE TABLE "legal_entity_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role_id" varchar(30),
	"granted_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entity_registrations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"type" varchar(40) NOT NULL,
	"country" varchar(2),
	"region" varchar(10),
	"number" varchar(64) NOT NULL,
	"label" varchar(120),
	"valid_from" date,
	"valid_to" date,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"verification" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "accounting_entity_settings" (
	"entity_id" varchar(30) PRIMARY KEY NOT NULL,
	"sales_lock_date" date,
	"purchase_lock_date" date,
	"tax_lock_date" date,
	"period_lock_date" date,
	"hard_lock_date" date,
	"accounting_method" varchar(10),
	"sales_tax_engine" varchar(30),
	"sales_tax_engine_config" jsonb,
	"sales_tax_credentials_encrypted" text,
	"fiscal_credentials_encrypted" text,
	"ssn_encrypted" text,
	"ssn_last4" varchar(4),
	"jurisdiction_settings" jsonb,
	"invoice_bank_account_id" varchar(30),
	"document_texts" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_bank_account_settings" (
	"bank_account_id" varchar(30) PRIMARY KEY NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"ledger_account_id" varchar(30),
	"current_balance" numeric(18, 2) DEFAULT '0',
	"last_import_date" timestamp,
	"last_import_balance" numeric(18, 2),
	"auto_reconcile" boolean DEFAULT true,
	"metadata" jsonb,
	"feed_connection_id" varchar(30),
	"feed_provider" varchar(30),
	"feed_account_id" varchar(255),
	"feed_account_fingerprint" varchar(255),
	"feed_sync_from" date,
	"feed_status" varchar(20),
	"next_check_number" integer,
	"check_settings" jsonb,
	"positive_pay_format" varchar(30),
	"import_settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "access_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "legal_entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_payroll_employers" ADD COLUMN "legal_entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_payroll_employers" ADD COLUMN "registration_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_payroll_employers" ADD COLUMN "bank_account_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_payroll_employers" ADD COLUMN "label" varchar(160);--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entity_members_entity_user_uidx" ON "legal_entity_members" USING btree ("entity_id","user_id");--> statement-breakpoint
CREATE INDEX "legal_entity_members_user_idx" ON "legal_entity_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "legal_entity_registrations_entity_type_idx" ON "legal_entity_registrations" USING btree ("entity_id","type");--> statement-breakpoint
CREATE INDEX "acct_bank_account_settings_entity_idx" ON "accounting_bank_account_settings" USING btree ("entity_id");--> statement-breakpoint
-- At most one default legal entity (docs/plans/legal-entities.md, release 1
-- step 1): keep settings.default_entity_id when it is a live default, else the
-- oldest live default; clear the rest before the unique index is built.
UPDATE "entities" SET "is_default" = false
WHERE "is_default" = true AND "deleted_at" IS NULL
  AND "id" <> COALESCE(
    (SELECT s."default_entity_id" FROM "settings" s
       JOIN "entities" d ON d."id" = s."default_entity_id" AND d."is_default" = true AND d."deleted_at" IS NULL
       LIMIT 1),
    (SELECT o."id" FROM "entities" o
       WHERE o."is_default" = true AND o."deleted_at" IS NULL
       ORDER BY o."created_at", o."id" LIMIT 1)
  );--> statement-breakpoint
CREATE UNIQUE INDEX "entities_single_default_uidx" ON "entities" USING btree ("is_default") WHERE "entities"."is_default" = true AND "entities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "hr_employees_legal_entity_idx" ON "hr_employees" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "hr_payroll_employers_legal_entity_idx" ON "hr_payroll_employers" USING btree ("legal_entity_id");