-- Backfill the new `<obj>:scope:all` permission grants for customers, contacts,
-- and leads onto every role / workspace_member / project_member row that
-- previously had unrestricted access (i.e. did NOT carry the old
-- `<obj>:scope:own` restriction flag).
--
-- Rationale:
--   The owner-scope model was inverted from a restriction flag (`:scope:own`,
--   absence = unrestricted) to an elevation grant (`:scope:all`, absence =
--   own-scoped). To preserve behaviour for existing users, every role that
--   *used to be* unrestricted needs the new explicit grant; roles that were
--   intentionally scoped (had `customers:scope:own`) are left untouched.
--
--   This migration is purely additive — the legacy `customers:scope:own`
--   keys stay in place to avoid a brief security regression during the
--   deploy window when old workers still read them.

-- ── customers ────────────────────────────────────────────────────────────
-- Skip rows that:
--   - already have `customers:scope:all` (idempotent),
--   - have the legacy `customers:scope:own` (intentionally scoped — preserve),
--   - have the global `*` wildcard (already covered via permission matcher).

UPDATE roles
SET permissions = permissions || '["customers:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["customers:scope:all"]'::jsonb)
  AND NOT (permissions @> '["customers:scope:own"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE workspace_members
SET permissions = permissions || '["customers:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["customers:scope:all"]'::jsonb)
  AND NOT (permissions @> '["customers:scope:own"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE project_members
SET permissions = permissions || '["customers:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["customers:scope:all"]'::jsonb)
  AND NOT (permissions @> '["customers:scope:own"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
-- ── contacts ─────────────────────────────────────────────────────────────
-- No legacy `contacts:scope:own` ever existed, so the only guards are
-- idempotency and the global wildcard.

UPDATE roles
SET permissions = permissions || '["contacts:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["contacts:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE workspace_members
SET permissions = permissions || '["contacts:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["contacts:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE project_members
SET permissions = permissions || '["contacts:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["contacts:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
-- ── leads ────────────────────────────────────────────────────────────────

UPDATE roles
SET permissions = permissions || '["leads:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["leads:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE workspace_members
SET permissions = permissions || '["leads:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["leads:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
--> statement-breakpoint
UPDATE project_members
SET permissions = permissions || '["leads:scope:all"]'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions @> '["leads:scope:all"]'::jsonb)
  AND NOT (permissions @> '["*"]'::jsonb);
