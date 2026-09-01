CREATE TABLE IF NOT EXISTS "phone_number_registry" (
	"phone_number" varchar(50) PRIMARY KEY NOT NULL,
	"clerk_org_id" varchar(255) NOT NULL,
	"voip_phone_number_id" varchar(30) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_number_registry_org_idx" ON "phone_number_registry" USING btree ("clerk_org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_number_registry_active_idx" ON "phone_number_registry" USING btree ("is_active");
