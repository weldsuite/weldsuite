-- ============================================================================
-- EU edition: the Free plan (2 members), and the workspaces made without it
-- ============================================================================
-- Run ONCE against the EU MASTER database (`weldsuite_master` on the CNPG
-- cluster `master`, namespace `postgres`). Wrapped in a transaction; review
-- the verification output before it commits.
--
-- Why: the EU master database started with an empty `plans` table, and
-- onboarding (`rust/modules/core-onboarding/src/onboard.rs`) puts a new
-- workspace on the plan with slug `free`, or on no plan when there is none.
-- A workspace with no plan has no member limit, so the invite dialog takes it
-- for a paid plan and reads its prepaid seats instead: one, so "All 1 seat
-- are in use" and nobody can be invited. Billing is off on the EU edition
-- (edition flag `billing`), so no seats can be bought either.
--
-- Free here allows 2 members. `max_users` is load-bearing: a plan with no
-- hard cap and no per-user price counts as unlimited (`plan_seat_limit` in
-- `rust/modules/core-team/src/groups/seats.rs`).
--
-- Zitadel needs no follow-up: it stores the membership cap but doesn't
-- enforce it; WeldSuite checks the seat limit from the plan.
--
-- Run it from a machine that reaches the cluster:
--   POD=$(kubectl -n postgres get pod -l cnpg.io/cluster=master,cnpg.io/instanceRole=primary -o name)
--   kubectl -n postgres exec -i "$POD" -- psql -v ON_ERROR_STOP=1 -d weldsuite_master < scripts/pricing/eu-free-plan.sql
-- ============================================================================

BEGIN;

-- 1) Free: 2 members, the plan new workspaces land on.
UPDATE plans SET
  name            = 'Free',
  description     = 'For small teams getting started',
  price_monthly   = 0,
  price_yearly    = 0,
  price_per_user  = 0,
  included_users  = 2,
  max_users       = 2,
  is_active       = true,
  is_default      = true,
  has_api_access  = false,
  remove_branding = false,
  sort_order      = 0,
  deleted_at      = NULL,
  updated_at      = now()
WHERE slug = 'free';

INSERT INTO plans (
  id, name, slug, description,
  price_monthly, price_yearly, price_per_user, included_users, max_users,
  is_active, is_default, has_api_access, remove_branding, sort_order,
  created_at, updated_at
)
SELECT
  'plan_free', 'Free', 'free', 'For small teams getting started',
  0, 0, 0, 2, 2,
  true, true, false, false, 0,
  now(), now()
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE slug = 'free');

-- 2) Every workspace onboarded before the row existed: onto Free.
UPDATE workspaces SET
  plan_id    = (SELECT id FROM plans WHERE slug = 'free' LIMIT 1),
  updated_at = now()
WHERE plan_id IS NULL
  AND deleted_at IS NULL;

-- 3) Verify before COMMIT.
SELECT slug, name, included_users, max_users, is_default, is_active
  FROM plans WHERE deleted_at IS NULL ORDER BY sort_order;

-- Expect 0.
SELECT count(*) AS without_plan FROM workspaces
  WHERE plan_id IS NULL AND deleted_at IS NULL;

COMMIT;
