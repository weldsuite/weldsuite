ALTER TABLE "crm_activities" ADD COLUMN "calendar_event_id" varchar(30);--> statement-breakpoint
CREATE INDEX "crm_activities_calendar_event_idx" ON "crm_activities" USING btree ("calendar_event_id");