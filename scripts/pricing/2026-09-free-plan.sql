-- ============================================================================
-- Free plan reopened — single-seat Free, Business capped at 10, no trial
-- ============================================================================
-- Run ONCE against the MASTER database (the one holding `plans` + `workspaces`).
-- Review every value below before running. Wrapped in a transaction so a failed
-- run rolls back cleanly.
--
-- Supersedes 2026-07-premium-pricing.sql, which closed Free to new signups and
-- put a 3-seat minimum on Business. The ladder is now:
--
--   free        $0        exactly 1 seat
--   business    $49/seat  1–10 seats
--   scale       $69/seat  11+, unlimited
--   enterprise  custom    custom
--
-- There is no free trial any more — Free is how people try WeldSuite. New
-- signups therefore land on Free instead of Business-with-a-trial, and the
-- "add payment or the workspace is deleted in 30 days" policy no longer
-- applies to them (see apps/workers/workspace-worker/src/routes/onboard.ts).
--
-- Prereqs / ordering:
--   1. Deploy the code change to onboard.ts (new signups → free, no
--      paidPlanRequired). Safe to deploy before this script: the lookup falls
--      back to a null planId if the free row is not ready yet.
--   2. Run THIS script.
--   3. No sync-stripe-plans.ts run is needed — Free has no Stripe price, and
--      Business/Scale per-seat amounts are unchanged.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Free — reopened, hard-capped at one seat.
--
--    max_users = 1 is load-bearing. calculateEffectiveSeatLimit() treats a
--    plan with no hard cap AND no per-user price as UNLIMITED (returns 0,
--    which clears Clerk's max_allowed_memberships). Leaving max_users NULL
--    here would hand every free workspace unlimited seats.
-- ---------------------------------------------------------------------------
UPDATE plans SET
  name            = 'Free',
  description     = 'For one person getting started',
  price_monthly   = 0,
  price_yearly    = 0,
  price_per_user  = 0,
  included_users  = 1,
  max_users       = 1,
  is_active       = true,
  is_default      = true,     -- the plan new signups land on
  has_api_access  = false,
  remove_branding = false,
  badge           = NULL,
  sort_order      = 0,        -- ahead of Business
  updated_at      = now()
WHERE slug = 'free';

-- Safety net: if there is no `free` row at all, create one. Uses the same
-- shape as the UPDATE above so both paths converge.
INSERT INTO plans (
  id, name, slug, description,
  price_monthly, price_yearly, price_per_user, included_users, max_users,
  is_active, is_default, has_api_access, remove_branding, sort_order,
  created_at, updated_at
)
SELECT
  'plan_free', 'Free', 'free', 'For one person getting started',
  0, 0, 0, 1, 1,
  true, true, false, false, 0,
  now(), now()
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE slug = 'free');

-- ---------------------------------------------------------------------------
-- 2) Business — 1 to 10 seats. Drops the 3-seat minimum and the 25-seat cap.
-- ---------------------------------------------------------------------------
UPDATE plans SET
  included_users = 1,         -- was 3 (the entry-tier minimum, now removed)
  max_users      = 10,        -- was 25; above 10 a workspace moves to Scale
  is_default     = false,     -- new signups land on Free now, not here
  updated_at     = now()
WHERE slug = 'business';

-- ---------------------------------------------------------------------------
-- 3) Scale / Enterprise — unchanged. Scale keeps max_users NULL (unlimited)
--    and its per-seat price, so its effective limit stays
--    included_users + purchased_seats.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4) Release workspaces from the no-free-plan policy.
--
--    Every workspace that never converted to a paid subscription moves to
--    Free and has its deletion schedule cleared, rather than being torn down
--    by the sweep in workspace-worker/src/services/deletion-sweep.ts.
--
--    "Never converted" = still flagged paidPlanRequired. Workspaces with a
--    live paid subscription have that flag cleared by the billing webhook
--    when the subscription activates, so they are untouched here.
--
--    Existing members are NOT removed. A workspace that already has more
--    than one member keeps them — Clerk's max_allowed_memberships prevents
--    NEW invites past the cap but never evicts current members.
--
--    `scheduled_deletion_at` is shared between this billing policy and
--    admin-initiated teardowns from the internal console, which are marked by
--    a non-null `deletion_requested_by`. Those are deliberate and must not be
--    cancelled here, so they are excluded outright.
-- ---------------------------------------------------------------------------
UPDATE workspaces SET
  plan_id               = (SELECT id FROM plans WHERE slug = 'free' AND deleted_at IS NULL LIMIT 1),
  paid_plan_required    = false,
  scheduled_deletion_at = NULL,
  trial_expired_at      = NULL,
  updated_at            = now()
WHERE paid_plan_required = true
  AND deleted_at IS NULL
  AND deletion_requested_by IS NULL;

-- ---------------------------------------------------------------------------
-- 5) Verify before COMMIT (uncomment to inspect inside a manual session):
-- ---------------------------------------------------------------------------
-- SELECT slug, name, price_per_user, included_users, max_users, is_default, sort_order
--   FROM plans WHERE deleted_at IS NULL ORDER BY sort_order;
--
-- SELECT count(*) AS still_flagged FROM workspaces
--   WHERE paid_plan_required = true AND deleted_at IS NULL
--     AND deletion_requested_by IS NULL;                      -- expect 0
--
-- Anything left here should be admin-scheduled only (deletion_requested_by set):
-- SELECT id, name, deletion_requested_by, scheduled_deletion_at FROM workspaces
--   WHERE scheduled_deletion_at IS NOT NULL AND deleted_at IS NULL;

COMMIT;

-- ============================================================================
-- AFTER COMMIT — Clerk reconciliation (not doable in SQL)
-- ============================================================================
-- Clerk's max_allowed_memberships is only rewritten when a workspace's plan
-- changes through the app (onboarding, billing webhooks). The workspaces moved
-- to Free in step 4 still carry their old Clerk cap until something syncs them.
--
-- Re-sync them with the existing helper so Clerk matches the plans table:
--   syncClerkSeatLimit(CLERK_SECRET_KEY, clerkOrgId, 1)
-- for every workspace whose plan is now `free`. calculateEffectiveSeatLimit()
-- already returns 1 for that plan; the sweep is only needed because nothing
-- re-runs it for a plan change made directly in SQL.
-- ============================================================================
