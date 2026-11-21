ALTER TABLE "helpcenter_settings" ADD COLUMN "portal_enabled" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "desk_visitors" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
ALTER TABLE "desk_visitors" ADD COLUMN "verified_email" varchar(255);--> statement-breakpoint
ALTER TABLE "desk_visitors" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "identity_secret" varchar(128);--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "identity_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_visitors_widget_external_id_uidx" ON "desk_visitors" USING btree ("widget_id","external_id") WHERE "desk_visitors"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "desk_visitors_verified_email_idx" ON "desk_visitors" USING btree ("verified_email");