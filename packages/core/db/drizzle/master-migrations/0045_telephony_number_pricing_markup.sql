ALTER TABLE "telephony_number_pricing" ADD COLUMN "markup_amount" integer;--> statement-breakpoint
ALTER TABLE "telephony_number_pricing" ADD COLUMN "markup_percent" numeric(5, 2);
