CREATE TABLE "telephony_number_pricing" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"country_code" varchar(5) NOT NULL,
	"number_type" varchar(20) NOT NULL,
	"monthly_price" numeric(10, 2) NOT NULL,
	"setup_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"provider" varchar(50) DEFAULT 'twilio' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telephony_service_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"service_type" varchar(50) NOT NULL,
	"credits_per_unit" numeric(10, 2) NOT NULL,
	"description" text,
	"unit_label" varchar(30),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telephony_service_rates_service_type_unique" UNIQUE("service_type")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "telephony_number_pricing_country_type_idx" ON "telephony_number_pricing" USING btree ("country_code","number_type");--> statement-breakpoint
CREATE INDEX "telephony_number_pricing_country_code_idx" ON "telephony_number_pricing" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "telephony_number_pricing_is_active_idx" ON "telephony_number_pricing" USING btree ("is_active");