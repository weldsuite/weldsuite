ALTER TABLE "admin_users" ADD COLUMN "console_subject" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_console_subject_idx" ON "admin_users" USING btree ("console_subject");