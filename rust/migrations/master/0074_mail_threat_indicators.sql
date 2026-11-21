CREATE TABLE "mail_threat_indicators" (
	"kind" varchar(10) NOT NULL,
	"value" varchar(2048) NOT NULL,
	"source" varchar(50) NOT NULL,
	"threat" varchar(20) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_threat_indicators_kind_value_pk" PRIMARY KEY("kind","value")
);
--> statement-breakpoint
CREATE INDEX "mail_threat_indicators_source_seen_idx" ON "mail_threat_indicators" USING btree ("source","last_seen_at");