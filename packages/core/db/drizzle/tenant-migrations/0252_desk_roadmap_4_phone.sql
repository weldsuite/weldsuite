CREATE TABLE "voip_sip_trunks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(20) DEFAULT 'other' NOT NULL,
	"auth_mode" varchar(20) NOT NULL,
	"ip_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sip_username" varchar(64),
	"transport" varchar(5) DEFAULT 'udp' NOT NULL,
	"provider_connection_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_inbound_at" timestamp,
	"last_error" text,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "sip_trunk_id" varchar(30);--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "translation" jsonb;--> statement-breakpoint
ALTER TABLE "voip_phone_numbers" ADD COLUMN "sip_trunk_id" varchar(30);--> statement-breakpoint
ALTER TABLE "voip_phone_numbers" ADD COLUMN "caller_id_verified_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "voip_sip_trunks_connection_uidx" ON "voip_sip_trunks" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX "voip_sip_trunks_status_idx" ON "voip_sip_trunks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "voip_phone_numbers_sip_trunk_idx" ON "voip_phone_numbers" USING btree ("sip_trunk_id");