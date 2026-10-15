CREATE TABLE "mail_correspondents" (
	"email" varchar(320) PRIMARY KEY NOT NULL,
	"first_inbound_at" timestamp,
	"last_inbound_at" timestamp,
	"inbound_count" integer DEFAULT 0 NOT NULL,
	"first_outbound_at" timestamp,
	"last_outbound_at" timestamp,
	"outbound_count" integer DEFAULT 0 NOT NULL,
	"replied_after_first_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"reason" varchar(20) NOT NULL,
	"sender_email" varchar(320),
	"source" varchar(40) NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_suppressions_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "delivery_status" varchar(20);--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "delivery_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "delivery_detail" varchar(500);--> statement-breakpoint
CREATE INDEX "mail_correspondents_first_outbound_idx" ON "mail_correspondents" USING btree ("first_outbound_at");--> statement-breakpoint
CREATE INDEX "mail_suppressions_reason_idx" ON "mail_suppressions" USING btree ("reason");--> statement-breakpoint
-- Hand-added (docs/plans/weldmail-outbound-abuse.md): keep the inbound side of
-- mail_correspondents current for every stored received message, whichever
-- path stored it (mail-inbound-worker, IMAP sync, …). SENT copies and
-- scheduled sends (source = 'sent') are recorded by the outbound guard instead.
CREATE OR REPLACE FUNCTION mail_correspondents_track_inbound() RETURNS trigger AS $$
DECLARE
  addr text := lower(btrim(NEW."from"->>'email'));
  at_time timestamp := COALESCE(NEW.received_date, NEW.sent_date, now());
BEGIN
  IF addr IS NULL OR addr = '' OR position('@' in addr) = 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO mail_correspondents AS c (email, first_inbound_at, last_inbound_at, inbound_count)
  VALUES (addr, at_time, at_time, 1)
  ON CONFLICT (email) DO UPDATE SET
    first_inbound_at = LEAST(COALESCE(c.first_inbound_at, EXCLUDED.first_inbound_at), EXCLUDED.first_inbound_at),
    last_inbound_at = GREATEST(COALESCE(c.last_inbound_at, EXCLUDED.last_inbound_at), EXCLUDED.last_inbound_at),
    inbound_count = c.inbound_count + 1,
    replied_after_first_contact = c.replied_after_first_contact
      OR (c.first_outbound_at IS NOT NULL AND (c.first_inbound_at IS NULL OR c.first_inbound_at > c.first_outbound_at)),
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mail_messages_track_inbound_correspondent
  AFTER INSERT ON mail_messages
  FOR EACH ROW
  WHEN (NEW.source IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION mail_correspondents_track_inbound();
--> statement-breakpoint
-- Backfill: everyone who ever wrote in (received mail, deleted included: they
-- still wrote to us) ...
INSERT INTO mail_correspondents (email, first_inbound_at, last_inbound_at, inbound_count)
SELECT lower(btrim(m."from"->>'email')),
       min(COALESCE(m.received_date, m.sent_date)),
       max(COALESCE(m.received_date, m.sent_date)),
       count(*)::int
FROM mail_messages m
WHERE m.source IS DISTINCT FROM 'sent'
  AND jsonb_typeof(m."from") = 'object'
  AND position('@' in COALESCE(m."from"->>'email', '')) > 0
GROUP BY 1
ON CONFLICT (email) DO NOTHING;
--> statement-breakpoint
-- ... and everyone the workspace sent to.
INSERT INTO mail_correspondents AS c (email, first_outbound_at, last_outbound_at, outbound_count)
SELECT lower(btrim(r->>'email')), min(m.sent_date), max(m.sent_date), count(*)::int
FROM mail_messages m
CROSS JOIN LATERAL jsonb_array_elements(
  (CASE WHEN jsonb_typeof(m."to") = 'array' THEN m."to" ELSE '[]'::jsonb END)
  || (CASE WHEN jsonb_typeof(m.cc) = 'array' THEN m.cc ELSE '[]'::jsonb END)
  || (CASE WHEN jsonb_typeof(m.bcc) = 'array' THEN m.bcc ELSE '[]'::jsonb END)
) AS r
WHERE m.source = 'sent'
  AND jsonb_typeof(r) = 'object'
  AND position('@' in COALESCE(r->>'email', '')) > 0
GROUP BY 1
ON CONFLICT (email) DO UPDATE SET
  first_outbound_at = EXCLUDED.first_outbound_at,
  last_outbound_at = EXCLUDED.last_outbound_at,
  outbound_count = EXCLUDED.outbound_count,
  -- We wrote first and they wrote back later.
  replied_after_first_contact = COALESCE(c.first_inbound_at > EXCLUDED.first_outbound_at, false);
