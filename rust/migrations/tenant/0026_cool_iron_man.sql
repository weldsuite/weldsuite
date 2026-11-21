DROP INDEX "helpdesk_conversations_customer_id_idx";--> statement-breakpoint
DROP INDEX "helpdesk_tickets_customer_id_idx";--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "contact_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN "contact_id" varchar(30);--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_contact_id_idx" ON "helpdesk_conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_contact_id_idx" ON "helpdesk_tickets" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" DROP COLUMN "customer_id";--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN "customer_id";