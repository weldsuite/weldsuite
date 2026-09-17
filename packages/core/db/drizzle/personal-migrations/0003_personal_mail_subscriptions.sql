CREATE TABLE "personal_mail_subscriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"personal_account_id" varchar(30) NOT NULL,
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_mail_subscriptions" ADD CONSTRAINT "personal_mail_subscriptions_account_id_personal_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mail_subscriptions_account_sender_uidx" ON "personal_mail_subscriptions" USING btree ("account_id","sender_email");--> statement-breakpoint
CREATE INDEX "personal_mail_subscriptions_personal_account_id_idx" ON "personal_mail_subscriptions" USING btree ("personal_account_id");