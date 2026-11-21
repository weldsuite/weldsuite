-- ============================================================================
-- SSO / SAML included in Business and Scale (was Enterprise only)
-- ============================================================================
-- Run ONCE against each MASTER database: Global (Neon) and the EU edition
-- (`weldsuite_master` on the CNPG cluster `master`, namespace `postgres`).
-- Wrapped in a transaction; review the verification output before it commits.
-- Safe to run again: it only sets a flag.
--
-- What decides it: a workspace may use single sign-on when its plan has
-- `features.sso = true` (`planIncludesSso` in
-- `@weldsuite/app-api-client/schemas/sso`, `plan_includes_sso` in
-- `rust/modules/core-platform/src/groups/sso.rs`). Until now only Enterprise
-- had it; Business and Scale could buy SSO as a €100/month add-on.
--
-- After this, every paid plan on Global includes SSO, so the add-on has no
-- buyers left: the settings page shows "Included in your plan" and refuses a
-- purchase (`INCLUDED_IN_PLAN`). Within the hour billing-worker's SSO sweep
-- switches on the Clerk connection of workspaces that had configured and
-- enabled SSO but were not entitled to it.
--
-- The EU edition sells its tiers as Free, Starter, Business and Enterprise
-- (Global's Business tier is its `starter`, Global's Scale tier its
-- `business`), so there SSO goes to Business and Enterprise and Starter keeps
-- none; it has no `scale` row. SSO connections on the EU edition need WeldID
-- as the identity provider (edition feature `sso-connections`): with Zitadel
-- the settings page stays hidden whatever the plan says.
--
-- Global:
--   psql "$MASTER_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/pricing/2026-11-sso-in-business.sql
-- EU (from a machine that reaches the cluster):
--   POD=$(kubectl -n postgres get pod -l cnpg.io/cluster=master,cnpg.io/instanceRole=primary -o name)
--   kubectl -n postgres exec -i "$POD" -c postgres -- psql -v ON_ERROR_STOP=1 -d weldsuite_master < scripts/pricing/2026-11-sso-in-business.sql
-- ============================================================================

BEGIN;

-- 0) What is there now, for the record.
SELECT slug, name, features -> 'sso' AS sso, is_active, deleted_at
  FROM plans ORDER BY sort_order ASC;

-- 1) Business, Scale and Enterprise include SSO. A slug a master doesn't
--    have (the EU master has no `scale`) is simply not touched, and the EU
--    master's `starter` stays without SSO.
UPDATE plans SET
  features   = coalesce(features, '{}'::jsonb) || '{"sso": true}'::jsonb,
  updated_at = now()
WHERE slug IN ('business', 'scale', 'enterprise')
  AND coalesce(features ->> 'sso', 'false') <> 'true';

-- 2) Verify before COMMIT: read-only.
SELECT slug, name, features -> 'sso' AS sso
  FROM plans WHERE deleted_at IS NULL ORDER BY sort_order;

-- Add-ons that are still being charged although the plan now includes SSO.
-- Each needs ending after COMMIT (see below). Expect none on the EU master.
SELECT w.id AS workspace_id, w.name, p.slug AS plan,
       s.stripe_subscription_id, s.subscription_status,
       s.subscription_cancel_at_period_end, s.subscription_current_period_end
  FROM workspace_sso s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN plans p ON p.id = w.plan_id
 WHERE s.subscription_status IN ('active', 'past_due', 'unpaid')
   AND (p.features ->> 'sso') = 'true'
 ORDER BY w.name;

COMMIT;

-- ============================================================================
-- AFTER COMMIT: end the add-ons the last query listed
-- ============================================================================
-- The plan covers SSO now, so nothing is lost by ending the add-on: the
-- entitlement source just moves from `subscription` to `plan`. Nothing ends
-- them automatically (the customer sees "Your plan now includes single
-- sign-on, so you no longer need the add-on" in Settings > Single sign-on).
--
-- For each workspace: admin console > Workspaces > (workspace) > Billing >
-- Single sign-on > Revoke SSO > Immediately, reason "SSO included in the plan
-- from 2026-11". That cancels the Stripe subscription with a prorated credit
-- for the rest of the month; single sign-on stays on through the plan.
