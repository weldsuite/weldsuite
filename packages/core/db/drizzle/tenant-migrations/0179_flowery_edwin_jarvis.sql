ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "rtr_registrant_handle" varchar(40);--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "rtr_process_id" varchar(64);