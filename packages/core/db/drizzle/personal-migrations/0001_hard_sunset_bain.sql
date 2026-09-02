CREATE TABLE "personal_device_tokens" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
	"clerk_user_id" varchar(255) NOT NULL,
	"device_id" varchar(255) NOT NULL,
	"platform" varchar(20) NOT NULL,
	"token" text NOT NULL,
	"token_type" varchar(20) DEFAULT 'expo' NOT NULL,
	"app_code" varchar(50) DEFAULT 'weldmail' NOT NULL,
	"app_version" varchar(50),
	"device_model" varchar(100),
	"os_version" varchar(50),
	"is_active" timestamp,
	"last_used_at" timestamp,
	CONSTRAINT "personal_device_tokens_account_device_app_unique" UNIQUE("personal_account_id","device_id","app_code")
);
--> statement-breakpoint
CREATE INDEX "personal_device_tokens_personal_account_idx" ON "personal_device_tokens" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "personal_device_tokens_clerk_user_idx" ON "personal_device_tokens" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "personal_device_tokens_app_code_idx" ON "personal_device_tokens" USING btree ("app_code");
