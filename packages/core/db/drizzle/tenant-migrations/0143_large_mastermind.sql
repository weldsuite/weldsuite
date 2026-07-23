DROP INDEX "parties_email_idx";--> statement-breakpoint
DROP INDEX "parties_type_idx";--> statement-breakpoint
DROP INDEX "parties_company_name_idx";--> statement-breakpoint
ALTER TABLE "parties" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "first_name";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "last_name";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "full_name";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "date_of_birth";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "gender";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "company_name";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "trading_name";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "registration_number";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "vat_number";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "industry";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "employee_count";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "annual_revenue";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "website";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "avatar_url";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "primary_contact_id";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "alternate_emails";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "mobile";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "fax";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "addresses";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "segment";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "rating";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "territory_id";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "preferred_contact_method";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "preferred_language";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "marketing_consent";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "email_opt_in";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "sms_opt_in";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "do_not_call";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "first_contact_date";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "last_contact_date";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "next_follow_up_date";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "lifecycle_stage";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "lead_score";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "satisfaction_score";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "nps_score";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "linkedin_url";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "twitter_handle";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "facebook_url";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "is_favorite";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "tags";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "custom_fields";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "notes";--> statement-breakpoint
ALTER TABLE "parties" DROP COLUMN "internal_notes";