CREATE TABLE "sign_signatures" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"recipient_id" varchar(30),
	"kind" varchar(24) NOT NULL,
	"level" varchar(8),
	"document" varchar(16) NOT NULL,
	"provider" varchar(255),
	"certificate_subject" varchar(500),
	"certificate_issuer" varchar(500),
	"certificate_serial" varchar(128),
	"certificate_not_after" timestamp with time zone,
	"qualified" boolean DEFAULT false NOT NULL,
	"identity_method" varchar(64),
	"signed_at" timestamp with time zone,
	"timestamp_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "pipeline" varchar(16);--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "prepared_storage_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "prepared_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "evidence_storage_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "evidence_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "ltv_renew_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD COLUMN "credits_reserved" integer;--> statement-breakpoint
ALTER TABLE "sign_recipients" ADD COLUMN "signature_level" varchar(8);--> statement-breakpoint
CREATE INDEX "sign_signatures_envelope_idx" ON "sign_signatures" USING btree ("envelope_id","created_at");