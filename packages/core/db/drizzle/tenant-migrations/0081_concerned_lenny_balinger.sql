ALTER TABLE "device_tokens" DROP CONSTRAINT "device_tokens_user_device_unique";--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "app_code" varchar(50) DEFAULT 'weldsuite' NOT NULL;--> statement-breakpoint
CREATE INDEX "device_tokens_app_code_idx" ON "device_tokens" USING btree ("app_code");--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_device_app_unique" UNIQUE("user_id","device_id","app_code");