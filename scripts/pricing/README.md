# Pricing rollouts

Scripts that move the platform's `plans` catalog in step with the marketing site
(weldsuite.org/pricing). Two rollouts so far, newest first.

## Current ladder (after `2026-09-free-plan.sql`)

| Slug         | Per-seat / mo | Seats        | Notes                                |
| ------------ | ------------- | ------------ | ------------------------------------ |
| `free`       | $0            | exactly 1    | open to new signups, the default plan |
| `business`   | $49           | 1–10         | above 10 seats, move to Scale        |
| `scale`      | $69           | 11+, unlimited | most popular                       |
| `enterprise` | custom        | custom       | book-a-demo                          |

**There is no free trial.** Free is how people try WeldSuite, so new signups are
no longer subject to the "add payment or the workspace is deleted in 30 days"
policy. See `2026-09-free-plan.sql` for the migration and the Clerk
reconciliation it cannot do in SQL.

> `free.max_users = 1` is load-bearing. `calculateEffectiveSeatLimit()` treats a
> plan with no hard cap and no per-user price as **unlimited**, so a Free row
> with `max_users` left NULL would hand out unlimited seats.

## Previous ladder (after `2026-07-premium-pricing.sql`)

Renamed the tiers and moved to premium pricing:

| Old (slug)            | New (slug)  | Per-seat / mo | Notes                          |
| --------------------- | ----------- | ------------- | ------------------------------ |
| `starter`             | `business`  | $49           | 3-seat min, up to 25 seats     |
| `pro`/`professional`  | `scale`     | $69           | unlimited seats, most popular  |
| `free`                | `free`      | $0            | closed to new signups, grandfathered |
| `enterprise`          | `enterprise`| custom        | book-a-demo                    |

The **code** changes (slug rename across auth, rate-limits, feature-flags, types,
billing UI, provisioning defaults) are already committed. The steps below apply
the parts that live outside the repo: the database, Stripe, and deploys.

## Run order — Free plan (2026-09)

1. **Deploy the code.** `onboard.ts` now puts new signups on `free` with
   `paidPlanRequired: false`, and the invite path refuses politely at the cap
   instead of returning a 500. Safe to deploy before the SQL: the plan lookup
   falls back to a null `planId` if the `free` row is not ready yet.

2. **Run the SQL** against the **master** DB:
   ```bash
   psql "$MASTER_DATABASE_URL" -f scripts/pricing/2026-09-free-plan.sql
   ```
   Reopens Free at one seat, caps Business at 10, and releases every
   never-converted workspace from the deletion policy. Admin-scheduled
   deletions (non-null `deletion_requested_by`) are deliberately left alone.
   Review the values and run the verification queries before `COMMIT`.

3. **Re-sync Clerk seat limits** for the workspaces step 2 moved to Free.
   Changing `plan_id` in SQL does not rewrite Clerk's
   `max_allowed_memberships` — only the app paths do. Call
   `syncClerkSeatLimit(CLERK_SECRET_KEY, clerkOrgId, 1)` for each. Until then
   those workspaces keep their old Clerk cap, which is permissive, not
   restrictive, so it is not urgent — but it means Free is unenforced for them.

4. **No Stripe sync needed.** Free has no Stripe price, and the Business/Scale
   per-seat amounts are unchanged.

## Run order — premium repricing (2026-07, already applied)

1. **Deploy the renamed code** (this branch). Nothing charges differently yet,    the plans rows still hold the old data.

2. **Run the SQL** against the **master** DB (holds `plans` + `workspaces`):
   ```bash
   psql "$MASTER_DATABASE_URL" -f scripts/pricing/2026-07-premium-pricing.sql
   ```
   Renames the `tenant_tier` enum values and updates the `plans` rows
   (slug/name/price_per_user/seat limits/badge). Idempotent-guarded; review values first.

3. **Sync Stripe** (creates new products/prices, archives old, writes ids back):
   ```bash
   STRIPE_SECRET_KEY=... MASTER_DATABASE_URL=... \
     tsx scripts/pricing/sync-stripe-plans.ts            # dry run first
   STRIPE_SECRET_KEY=... MASTER_DATABASE_URL=... \
     tsx scripts/pricing/sync-stripe-plans.ts --apply    # then apply
   ```
   Review `PLAN_PRICING` and `CURRENCY` at the top of the script before `--apply`.
   Run against **test** Stripe first, verify, then live.

4. **Redeploy `apps/workers/external-api`.** The rate-limit bindings were renamed
   `RL_STARTER→RL_BUSINESS` and `RL_PROFESSIONAL→RL_SCALE` in `wrangler.toml`
   (all env blocks). Cloudflare provisions the native rate-limit namespaces from
   that config on deploy, until you redeploy, the renamed tiers won't have a
   limiter and fall back to `RL_FREE` via `getTierRateLimit`.

## Caveats / decisions still open

- **Drizzle migration tracking.** The `tenant_tier` enum-value rename is applied
  by the SQL above, not by a generated Drizzle migration (drizzle-kit does not
  emit `ALTER TYPE … RENAME VALUE` safely, it tends to drop/recreate the type).
  `packages/core/db/src/schema/master.ts` already reflects the new values. After
  applying, run `pnpm --filter @weldsuite/db db:generate:master` once and confirm
  it produces **no** destructive enum diff before committing any generated file.

- **Card-required trial (NOT done in code), new signups ONLY.** The finalized
  model requires a card at trial start **for brand-new signups only**; existing
  and grandfathered accounts must never be forced to add a card. Today the trial
  is created **cardless** in a non-interactive provisioning workflow
  (`apps/workers/workspace-worker/src/services/provisioning.ts` → `setupWorkspaceBilling`,
  called from the `provision-workspace` Workflow), so it cannot collect a card
  there. Enforcing card-required for new signups needs an onboarding flow change,   start the new workspace's trial via a Stripe **Checkout session** (subscription
  mode, `subscription_data[trial_period_days]=14`, card collected) during
  onboarding instead of auto-creating the cardless trial. Existing accounts
  changing plans keep the current in-app flow untouched. See the `TODO(pricing)`
  in `provisioning.ts`.

- **Currency.** `plans.currency` defaults to `EUR`, but the billing UI formats in
  `USD` and marketing shows `$`. Confirm the intended currency and set it
  consistently in the SQL row data and the Stripe sync `CURRENCY`.

- **Grandfathering.** Existing workspaces keep their current plan. The SQL updates
  the shared plan catalog rows in place, so already-subscribed workspaces move to
  the new price at their next Stripe cycle unless you branch the plan rows. If you
  need to hold existing customers at old prices, create new plan rows for
  Business/Scale instead of updating in place, and only point new signups at them.
