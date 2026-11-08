-- Legal entities, release 1: data backfill (docs/plans/legal-entities.md,
-- "Release 1 (expand)"). Deterministic copies with ids derived from their
-- source rows, so the statements are safe to run again. What SQL cannot do
-- (decrypting bank details, merging the workspace business profile) is done
-- by apps/tools/migrate-databases backfill-legal-entities.
--
-- 1. WeldBooks extension: one accounting_entity_settings row per entity
--    (every entity before this release is a WeldBooks entity).
INSERT INTO "accounting_entity_settings" (
  "entity_id", "sales_lock_date", "purchase_lock_date", "tax_lock_date", "period_lock_date", "hard_lock_date",
  "accounting_method", "sales_tax_engine", "sales_tax_engine_config", "sales_tax_credentials_encrypted",
  "fiscal_credentials_encrypted", "ssn_encrypted", "ssn_last4", "jurisdiction_settings", "document_texts",
  "created_at", "updated_at"
)
SELECT
  e."id", e."sales_lock_date", e."purchase_lock_date", e."tax_lock_date", e."period_lock_date", e."hard_lock_date",
  e."accounting_method", e."sales_tax_engine", e."sales_tax_engine_config", e."sales_tax_credentials_encrypted",
  e."fiscal_credentials_encrypted", e."ssn_encrypted", e."ssn_last4", e."jurisdiction_settings",
  NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'footerText', e."branding" -> 'footerText',
    'paymentInstructions', e."branding" -> 'paymentInstructions',
    'termsAndConditions', e."branding" -> 'termsAndConditions'
  )), '{}'::jsonb),
  e."created_at", now()
FROM "entities" e
-- Not the entities step 4 creates from WeldHR employers (a re-run must not
-- enable WeldBooks for them).
WHERE NOT EXISTS (
  SELECT 1 FROM "hr_payroll_employers" h
  WHERE e."id" = 'ent_' || substr(md5('hr_employer:' || h."id"), 1, 24)
)
ON CONFLICT ("entity_id") DO NOTHING;
--> statement-breakpoint

-- 2. WeldBooks extension of every existing bank account.
INSERT INTO "accounting_bank_account_settings" (
  "bank_account_id", "entity_id", "ledger_account_id", "current_balance", "last_import_date", "last_import_balance",
  "auto_reconcile", "metadata", "feed_connection_id", "feed_provider", "feed_account_id", "feed_account_fingerprint",
  "feed_sync_from", "feed_status", "next_check_number", "check_settings", "positive_pay_format", "import_settings",
  "created_at", "updated_at"
)
SELECT
  b."id", b."entity_id", b."ledger_account_id", b."current_balance", b."last_import_date", b."last_import_balance",
  b."auto_reconcile", b."metadata", b."feed_connection_id", b."feed_provider", b."feed_account_id", b."feed_account_fingerprint",
  b."feed_sync_from", b."feed_status", b."next_check_number", b."check_settings", b."positive_pay_format", b."import_settings",
  b."created_at", now()
FROM "bank_accounts" b
ON CONFLICT ("bank_account_id") DO NOTHING;
--> statement-breakpoint

-- 3. Registrations from entities.tax_identifiers. These are the entity's own
--    numbers and start as primary.
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "is_primary", "created_at", "updated_at")
SELECT
  'ler_' || substr(md5('vat:' || e."id"), 1, 24), e."id",
  CASE WHEN upper(left(e."jurisdiction_code", 2)) = 'IN' THEN 'gstin' ELSE 'vat' END,
  upper(left(e."jurisdiction_code", 2)),
  left(upper(regexp_replace(e."tax_identifiers" ->> 'vatNumber', '[[:space:].]', '', 'g')), 64),
  true, e."created_at", now()
FROM "entities" e
WHERE NULLIF(trim(e."tax_identifiers" ->> 'vatNumber'), '') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "is_primary", "created_at", "updated_at")
SELECT
  'ler_' || substr(md5('company_registration:' || e."id"), 1, 24), e."id", 'company_registration',
  upper(left(e."jurisdiction_code", 2)),
  left(trim(e."tax_identifiers" ->> 'registrationNumber'), 64),
  true, e."created_at", now()
FROM "entities" e
WHERE NULLIF(trim(e."tax_identifiers" ->> 'registrationNumber'), '') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Only an unambiguous EIN (12-3456789). Nine bare digits may be an SSN; the
-- backfill script reports those for review.
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "is_primary", "created_at", "updated_at")
SELECT
  'ler_' || substr(md5('ein:' || e."id"), 1, 24), e."id", 'ein', 'US',
  trim(e."tax_identifiers" ->> 'einOrSsn'),
  true, e."created_at", now()
FROM "entities" e
WHERE trim(e."tax_identifiers" ->> 'einOrSsn') ~ '^[0-9]{2}-[0-9]{7}$'
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "label", "is_primary", "created_at", "updated_at")
SELECT
  'ler_' || substr(md5('other:' || e."id" || ':' || o."key"), 1, 24), e."id", 'other',
  upper(left(e."jurisdiction_code", 2)), left(trim(o."value"), 64), left(o."key", 120),
  false, e."created_at", now()
FROM "entities" e
CROSS JOIN LATERAL jsonb_each_text(
  CASE WHEN jsonb_typeof(e."tax_identifiers" -> 'other') = 'object' THEN e."tax_identifiers" -> 'other' ELSE '{}'::jsonb END
) AS o("key", "value")
WHERE NULLIF(trim(o."value"), '') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- 4. WeldHR employers become payroll registrations of a legal entity. An
--    employer linked to a live entity keeps it.
UPDATE "hr_payroll_employers" h
SET "legal_entity_id" = h."accounting_entity_id"
WHERE h."legal_entity_id" IS NULL
  AND h."accounting_entity_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = h."accounting_entity_id" AND e."deleted_at" IS NULL);
--> statement-breakpoint
-- An unlinked employer gets a new legal entity from its own name, country,
-- currency and address. Unlinked employers of the same company (same legal
-- name and country) share one entity, anchored on the oldest employer.
INSERT INTO "entities" (
  "id", "name", "legal_name", "jurisdiction_code", "base_currency", "locale", "timezone", "address",
  "is_default", "is_active", "access_restricted", "created_at", "updated_at"
)
SELECT
  'ent_' || substr(md5('hr_employer:' || h."id"), 1, 24),
  h."name", h."legal_name", upper(h."country"), upper(h."currency"),
  CASE upper(h."country") WHEN 'NL' THEN 'nl-NL' WHEN 'US' THEN 'en-US' ELSE 'en-GB' END,
  CASE upper(h."country") WHEN 'NL' THEN 'Europe/Amsterdam' ELSE NULL END,
  jsonb_strip_nulls(jsonb_build_object(
    'line1', h."address" -> 'line1',
    'line2', h."address" -> 'line2',
    'houseNumber', h."address" -> 'houseNumber',
    'houseNumberAddition', h."address" -> 'houseNumberAddition',
    'postalCode', h."address" -> 'postalCode',
    'city', h."address" -> 'city',
    'state', h."address" -> 'region',
    'country', h."address" -> 'country'
  )),
  false, true, false, h."created_at", now()
FROM "hr_payroll_employers" h
WHERE h."legal_entity_id" IS NULL
  AND h."deleted_at" IS NULL
  AND h."id" = (
    SELECT a."id" FROM "hr_payroll_employers" a
    WHERE a."legal_entity_id" IS NULL AND a."deleted_at" IS NULL
      AND lower(trim(a."legal_name")) = lower(trim(h."legal_name"))
      AND upper(a."country") = upper(h."country")
    ORDER BY a."created_at", a."id" LIMIT 1
  )
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "hr_payroll_employers" h
SET "legal_entity_id" = 'ent_' || substr(md5('hr_employer:' || (
  SELECT a."id" FROM "hr_payroll_employers" a
  WHERE a."legal_entity_id" IS NULL AND a."deleted_at" IS NULL
    AND lower(trim(a."legal_name")) = lower(trim(h."legal_name"))
    AND upper(a."country") = upper(h."country")
  ORDER BY a."created_at", a."id" LIMIT 1
)), 1, 24)
WHERE h."legal_entity_id" IS NULL AND h."deleted_at" IS NULL;
--> statement-breakpoint

-- 5. Every workspace with a live entity has a default: settings.default_entity_id
--    when it is live, else the oldest WeldBooks entity, else the oldest one.
UPDATE "entities" SET "is_default" = true, "updated_at" = now()
WHERE "id" = COALESCE(
    (SELECT s."default_entity_id" FROM "settings" s
       JOIN "entities" d ON d."id" = s."default_entity_id" AND d."deleted_at" IS NULL
       LIMIT 1),
    (SELECT o."id" FROM "entities" o
       WHERE o."deleted_at" IS NULL
       ORDER BY (EXISTS (SELECT 1 FROM "accounting_entity_settings" x WHERE x."entity_id" = o."id")) DESC,
                (o."is_active" IS NOT FALSE) DESC, o."created_at", o."id"
       LIMIT 1)
  )
  AND NOT EXISTS (SELECT 1 FROM "entities" d WHERE d."is_default" = true AND d."deleted_at" IS NULL);
--> statement-breakpoint

-- 6. Payroll registrations from the employers: the loonheffingennummer, the
--    EIN and the US state account numbers. An equal number already on the
--    entity is reused, not copied.
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "label", "is_primary", "created_at", "updated_at")
SELECT DISTINCT ON (h."legal_entity_id", n."number")
  'ler_' || substr(md5('nl_payroll_tax:' || h."id"), 1, 24), h."legal_entity_id", 'nl_payroll_tax', 'NL',
  n."number", left(h."name", 120), false, h."created_at", now()
FROM "hr_payroll_employers" h
CROSS JOIN LATERAL (
  SELECT left(upper(regexp_replace(h."nl_settings" ->> 'loonheffingennummer', '[[:space:].]', '', 'g')), 64) AS "number"
) n
WHERE h."legal_entity_id" IS NOT NULL
  AND NULLIF(n."number", '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "legal_entity_registrations" r
    WHERE r."entity_id" = h."legal_entity_id" AND r."type" = 'nl_payroll_tax' AND r."number" = n."number" AND r."deleted_at" IS NULL
  )
ORDER BY h."legal_entity_id", n."number", h."created_at", h."id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "number", "label", "is_primary", "created_at", "updated_at")
SELECT DISTINCT ON (h."legal_entity_id", n."number")
  'ler_' || substr(md5('ein:hr:' || h."id"), 1, 24), h."legal_entity_id", 'ein', 'US',
  n."number", left(h."name", 120), false, h."created_at", now()
FROM "hr_payroll_employers" h
CROSS JOIN LATERAL (SELECT left(trim(h."us_settings" ->> 'ein'), 64) AS "number") n
WHERE h."legal_entity_id" IS NOT NULL
  AND NULLIF(n."number", '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "legal_entity_registrations" r
    WHERE r."entity_id" = h."legal_entity_id" AND r."type" = 'ein'
      AND regexp_replace(r."number", '[^0-9]', '', 'g') = regexp_replace(n."number", '[^0-9]', '', 'g')
      AND r."deleted_at" IS NULL
  )
ORDER BY h."legal_entity_id", n."number", h."created_at", h."id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "legal_entity_registrations" ("id", "entity_id", "type", "country", "region", "number", "is_primary", "created_at", "updated_at")
SELECT DISTINCT ON (h."legal_entity_id", k."type", st."key", k."number")
  'ler_' || substr(md5(k."type" || ':' || h."id" || ':' || st."key"), 1, 24), h."legal_entity_id", k."type", 'US',
  left(upper(st."key"), 10), k."number", false, h."created_at", now()
FROM "hr_payroll_employers" h
CROSS JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(h."us_settings" -> 'states') = 'object' THEN h."us_settings" -> 'states' ELSE '{}'::jsonb END
) AS st("key", "value")
CROSS JOIN LATERAL (
  VALUES
    ('us_state_withholding', left(trim(st."value" ->> 'withholdingAccountNumber'), 64)),
    ('us_state_unemployment', left(trim(st."value" ->> 'suiAccountNumber'), 64))
) AS k("type", "number")
WHERE h."legal_entity_id" IS NOT NULL
  AND NULLIF(k."number", '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "legal_entity_registrations" r
    WHERE r."entity_id" = h."legal_entity_id" AND r."type" = k."type" AND r."region" = left(upper(st."key"), 10)
      AND r."number" = k."number" AND r."deleted_at" IS NULL
  )
ORDER BY h."legal_entity_id", k."type", st."key", k."number", h."created_at", h."id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- The oldest registration of a national type becomes primary where the entity
-- has none yet (a different EIN from payroll stays non-primary).
UPDATE "legal_entity_registrations" r SET "is_primary" = true, "updated_at" = now()
WHERE r."type" IN ('vat', 'gstin', 'company_registration', 'rsin', 'ein', 'pan', 'eori', 'nl_payroll_tax')
  AND r."deleted_at" IS NULL
  AND r."id" = (
    SELECT f."id" FROM "legal_entity_registrations" f
    WHERE f."entity_id" = r."entity_id" AND f."type" = r."type" AND f."deleted_at" IS NULL
    ORDER BY f."created_at", f."id" LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM "legal_entity_registrations" p
    WHERE p."entity_id" = r."entity_id" AND p."type" = r."type" AND p."is_primary" = true AND p."deleted_at" IS NULL
  );
--> statement-breakpoint
-- The registration each employer's payroll runs under.
UPDATE "hr_payroll_employers" h
SET "registration_id" = (
  SELECT r."id" FROM "legal_entity_registrations" r
  WHERE r."entity_id" = h."legal_entity_id" AND r."deleted_at" IS NULL
    AND (
      (upper(h."country") = 'NL' AND r."type" = 'nl_payroll_tax'
        AND r."number" = upper(regexp_replace(h."nl_settings" ->> 'loonheffingennummer', '[[:space:].]', '', 'g')))
      OR (upper(h."country") = 'US' AND r."type" = 'ein'
        AND regexp_replace(r."number", '[^0-9]', '', 'g') = regexp_replace(h."us_settings" ->> 'ein', '[^0-9]', '', 'g'))
    )
  ORDER BY r."created_at", r."id" LIMIT 1
)
WHERE h."registration_id" IS NULL AND h."legal_entity_id" IS NOT NULL;
--> statement-breakpoint

-- 7. Every employee gets an employing legal entity: their payroll employer's,
--    else the default.
UPDATE "hr_employees" emp
SET "legal_entity_id" = h."legal_entity_id"
FROM "hr_payroll_profiles" p
JOIN "hr_payroll_employers" h ON h."id" = p."employer_id"
WHERE p."employee_id" = emp."id"
  AND emp."legal_entity_id" IS NULL
  AND h."legal_entity_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "hr_employees"
SET "legal_entity_id" = (SELECT d."id" FROM "entities" d WHERE d."is_default" = true AND d."deleted_at" IS NULL LIMIT 1)
WHERE "legal_entity_id" IS NULL
  AND EXISTS (SELECT 1 FROM "entities" d WHERE d."is_default" = true AND d."deleted_at" IS NULL);
--> statement-breakpoint

-- 8. Custom roles (system roles are answered from code). Everyone could see
--    entities before, so every custom role gets legal_entities:read; roles
--    that could create or edit a WeldBooks administration, payroll employers
--    or the business profile keep that on the core entity; tax-id revealers
--    may reveal bank account numbers.
UPDATE "roles"
SET "permissions" = COALESCE("permissions", '[]'::jsonb) || '["legal_entities:read"]'::jsonb, "updated_at" = now()
WHERE "is_system" = false AND "deleted_at" IS NULL
  AND jsonb_typeof(COALESCE("permissions", '[]'::jsonb)) = 'array'
  AND NOT jsonb_exists(COALESCE("permissions", '[]'::jsonb), 'legal_entities:read');
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || (
    SELECT COALESCE(jsonb_agg(k), '[]'::jsonb)
    FROM unnest(ARRAY['legal_entities:create', 'legal_entities:update', 'legal_entities:delete']) AS k
    WHERE NOT jsonb_exists("roles"."permissions", k)
  ),
  "updated_at" = now()
WHERE "is_system" = false AND "deleted_at" IS NULL
  AND jsonb_typeof("permissions") = 'array'
  AND jsonb_exists_any("permissions", ARRAY[
    'entities:create', 'entities:update', 'entities:delete', 'entities:manage', 'entities:*',
    'weldbooks:entities:create', 'weldbooks:entities:update', 'weldbooks:entities:delete', 'weldbooks:entities:manage',
    'weldbooks:entities:*', 'weldbooks:*',
    'payroll:manage', 'payroll:*', 'weldhr:payroll:manage', 'weldhr:payroll:*', 'weldhr:*',
    'general:update', 'general:*', 'settings:general:update', 'settings:*'
  ])
  AND NOT jsonb_exists_all("permissions", ARRAY['legal_entities:create', 'legal_entities:update', 'legal_entities:delete']);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["legal_entities:reveal"]'::jsonb, "updated_at" = now()
WHERE "is_system" = false AND "deleted_at" IS NULL
  AND jsonb_typeof("permissions") = 'array'
  AND jsonb_exists_any("permissions", ARRAY['tax_ids:reveal', 'tax_ids:*', 'weldbooks:tax_ids:reveal', 'weldbooks:tax_ids:*', 'weldbooks:*'])
  AND NOT jsonb_exists("permissions", 'legal_entities:reveal');
