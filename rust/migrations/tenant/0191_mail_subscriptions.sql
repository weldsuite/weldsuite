-- WeldMail subscriptions: mailing lists / newsletters a mailbox receives,
-- one row per sender address, with Gmail-style unsubscribe state. Upserted by
-- mail-inbound-worker from List-Unsubscribe headers and backfilled by
-- POST /api/mail-subscriptions/scan.
CREATE TABLE IF NOT EXISTS "mail_subscriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"account_id" varchar(30) NOT NULL,
	"sender_email" varchar(320) NOT NULL,
	"sender_name" varchar(255),
	"sender_domain" varchar(255),
	"list_id" varchar(500),
	"unsubscribe_url" text,
	"unsubscribe_mailto" text,
	"one_click" boolean DEFAULT false NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_subject" varchar(998),
	"first_received_at" timestamp DEFAULT now() NOT NULL,
	"last_received_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"unsubscribe_method" varchar(20),
	"unsubscribed_at" timestamp,
	"unsubscribed_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_subscriptions" ADD CONSTRAINT "mail_subscriptions_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_subscriptions_account_sender_uidx" ON "mail_subscriptions" USING btree ("account_id","sender_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_subscriptions_account_last_received_idx" ON "mail_subscriptions" USING btree ("account_id","last_received_at");
