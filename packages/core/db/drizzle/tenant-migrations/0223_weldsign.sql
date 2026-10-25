CREATE TABLE "sign_documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"storage_key" varchar(1000) NOT NULL,
	"size_bytes" integer NOT NULL,
	"page_count" integer NOT NULL,
	"page_sizes" jsonb NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_envelopes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"kind" varchar(20) DEFAULT 'envelope' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text,
	"sender_user_id" varchar(255) NOT NULL,
	"sender_name" varchar(255),
	"sender_email" varchar(320),
	"signing_order_enabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"reminder_after_days" integer,
	"reminder_every_days" integer,
	"reminder_max_count" integer,
	"source" jsonb,
	"file_back_folder_id" varchar(255),
	"template_id" varchar(30),
	"final_sha256" varchar(64),
	"final_storage_key" varchar(1000),
	"voided_reason" text,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sign_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"recipient_id" varchar(30),
	"type" varchar(30) NOT NULL,
	"actor_user_id" varchar(255),
	"actor_name" varchar(255),
	"actor_email" varchar(320),
	"ip" varchar(64),
	"user_agent" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_fields" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"document_id" varchar(30) NOT NULL,
	"recipient_id" varchar(30) NOT NULL,
	"type" varchar(20) NOT NULL,
	"page" integer NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"width" real NOT NULL,
	"height" real NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" varchar(255),
	"value" text,
	"signature_key" varchar(1000),
	"filled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_recipients" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"envelope_id" varchar(30) NOT NULL,
	"role" varchar(20) DEFAULT 'signer' NOT NULL,
	"role_name" varchar(100),
	"name" varchar(255),
	"email" varchar(320),
	"person_id" varchar(30),
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"routing_order" integer DEFAULT 1 NOT NULL,
	"auth_mode" varchar(20) DEFAULT 'link' NOT NULL,
	"access_code_hash" varchar(64),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"decline_reason" text,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone,
	"signed_ip" varchar(64),
	"signed_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"default_expiry_days" integer DEFAULT 30 NOT NULL,
	"default_reminder_after_days" integer DEFAULT 3,
	"default_reminder_every_days" integer DEFAULT 3,
	"default_reminder_max_count" integer DEFAULT 3,
	"brand_name" varchar(255),
	"brand_color" varchar(20),
	"brand_logo_url" varchar(1000),
	"default_file_back_folder_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sign_documents_envelope_idx" ON "sign_documents" USING btree ("envelope_id","position");--> statement-breakpoint
CREATE INDEX "sign_envelopes_kind_status_idx" ON "sign_envelopes" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "sign_envelopes_sender_idx" ON "sign_envelopes" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "sign_envelopes_sent_at_idx" ON "sign_envelopes" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "sign_envelopes_expires_at_idx" ON "sign_envelopes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sign_events_envelope_idx" ON "sign_events" USING btree ("envelope_id","created_at");--> statement-breakpoint
CREATE INDEX "sign_fields_envelope_idx" ON "sign_fields" USING btree ("envelope_id");--> statement-breakpoint
CREATE INDEX "sign_fields_recipient_idx" ON "sign_fields" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "sign_recipients_envelope_idx" ON "sign_recipients" USING btree ("envelope_id","routing_order");--> statement-breakpoint
CREATE INDEX "sign_recipients_email_idx" ON "sign_recipients" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_settings_workspace_idx" ON "sign_settings" USING btree ("workspace_id");