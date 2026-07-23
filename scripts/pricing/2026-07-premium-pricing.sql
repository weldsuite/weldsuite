-- ============================================================================
-- Premium repricing — rename plan tiers + update the plans catalog
-- ============================================================================
-- Run ONCE against the MASTER database (the one holding `plans` + `workspaces`).
-- Review every value below before running. Wrapped in a transaction so a failed
-- run rolls back cleanly.
--
-- Mapping:  starter → business ($49/seat/mo)   pro|professional → scale ($69/seat/mo)
--           free → free (unchanged, grandfathered)   enterprise → enterprise (unchanged)
--
-- Prereqs / ordering (see README.md in this folder):
--   1. Deploy the code that renames the slugs (already committed).
--   2. Run THIS script.
--   3. Run sync-stripe-plans.ts to (re)create Stripe products/prices and write
--      the stripe_* ids back onto the plans rows.
--   4. Redeploy apps/workers/external-api so the renamed RL_BUSINESS / RL_SCALE
--      rate-limit bindings take effect.
-- ============================================================================

BEGIN;

-- 1) Rename the tenant_tier enum VALUES (guarded, so a re-run is a no-op).
--    No table column currently uses this enum, so this is a pure type update
--    that keeps the DB in sync with packages/core/db/src/schema/master.ts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'tenant_tier' AND e.enumlabel = 'starter'
  ) THEN
    ALTER TYPE tenant_tier RENAME VALUE 'starter' TO 'business';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'tenant_tier' AND e.enumlabel = 'professional'
  ) THEN
    ALTER TYPE tenant_tier RENAME VALUE 'professional' TO 'scale';
  END IF;
END $$;

-- 2) Update the plans catalog.
--    NOTE: `features` (jsonb) is intentionally left untouched — adjust it
--    manually if your feature-flag payload needs to change. Confirm the
--    currency on these rows matches what the app displays (see README).

-- Business — entry paid tier (was 'starter')
UPDATE plans SET
  slug           = 'business',
  name           = 'Business',
  description    = 'For teams standardizing on one suite',
  price_per_user = 49,
  included_users = 3,        -- 3-seat minimum on the entry tier
  max_users      = 25,       -- Business caps at 25 seats; upgrade to Scale beyond
  badge          = NULL,
  remove_branding = true,
  has_api_access = true,     -- API + webhooks now included from Business
  updated_at     = now()
WHERE slug = 'starter';

-- Scale — most-popular tier (was 'pro' or 'professional')
UPDATE plans SET
  slug           = 'scale',
  name           = 'Scale',
  description    = 'For mid-market running the business on WeldSuite',
  price_per_user = 69,
  included_users = 1,
  max_users      = NULL,     -- unlimited seats
  badge          = 'Most popular',
  remove_branding = true,
  has_api_access = true,
  updated_at     = now()
WHERE slug IN ('pro', 'professional');

-- Free & Enterprise rows are intentionally left unchanged.

-- 3) Verify before COMMIT (uncomment to inspect inside a manual session):
-- SELECT slug, name, price_per_user, included_users, max_users, badge, has_api_access
--   FROM plans WHERE deleted_at IS NULL ORDER BY sort_order;

COMMIT;
