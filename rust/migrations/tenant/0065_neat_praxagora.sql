ALTER TABLE "mail_messages" DROP CONSTRAINT "mail_messages_folder_id_mail_folders_id_fk";
--> statement-breakpoint
DROP INDEX "mail_messages_folder_id_idx";--> statement-breakpoint
DROP INDEX "mail_messages_is_starred_idx";--> statement-breakpoint
ALTER TABLE "mail_labels" ADD COLUMN "is_system" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "mail_labels" ADD COLUMN "slug" varchar(50);--> statement-breakpoint
CREATE INDEX "mail_messages_labels_gin" ON "mail_messages" USING gin ("labels");--> statement-breakpoint
ALTER TABLE "mail_messages" DROP COLUMN "folder_id";