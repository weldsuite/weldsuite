ALTER TABLE "calendar_booking_pages" ADD COLUMN "date_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_booking_pages" ADD COLUMN "max_bookings_per_day" integer;