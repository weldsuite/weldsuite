# Reseller licensing (partner-managed workspaces)

Status: **design, not started.** No schema, migration or code yet.

## Problem

A reseller sells WeldSuite to their own customers in North and South America.
They need to:

1. Create workspaces for their customers and **license** each one: which apps
   it may use, how many credits a month it gets, and optionally how many seats.
2. **Charge their customer whatever they want**: a flat fee for the whole
   workspace or a per-user price.
3. **Record that price**, because the contract is a revenue share. The reseller
   keeps 25% of what they charge, WeldSuite gets 75%.
4. Pay WeldSuite **at least a base minimum per workspace** per month, even if 75%
   of their price is lower.

Today none of this has a home. The code has:

- no partner or parent account;
- a workspace that is its own Stripe customer and per-seat subscription;
- no licensing layer.

The rest of this plan builds those pieces on what already exists.

## Decisions taken (with the owner, 2026-10-10)

| Question | Answer |
|---|---|
| Who bills the end customer? | **The reseller.** WeldSuite sends the reseller one statement a month and never bills their customers. |
| Reseller price | Free to choose. The reseller records it in WeldSuite. **WeldSuite's share is 75% of it**; the reseller keeps 25%. |
| Base minimum | **A floor on what WeldSuite charges** per workspace per month. |
| Credits | **A monthly allowance per workspace**, set by the reseller and reset every month. |
| Reseller UI | **A partner portal inside the WeldSuite platform app.** |
| Pricing shape | **Flat fee per workspace or per user.** The reseller chooses per workspace; per-seat is never forced. |

## What exists today (and what it means for this plan)

From a survey of the repo at `74fd7d68`:

**Billing (master DB)**
- The subscription lives on `workspaces` (`packages/core/db/src/schema/master.ts:107-216`).
- Each workspace has one Stripe customer and one per-seat line item.
- `plans` (`schema/plans.ts:61`) carries the price, `monthly_credits` and the limits.
- **No base or minimum fee exists.** Modules are not priced: `app_catalog` has no price columns.

**Country pricing**
- Stored as a `system_settings` JSON row, `billing.plan_country_pricing`.
- Applied at checkout as inline Stripe prices.
- **Partner workspaces bypass it**: their price is the reseller's, and WeldSuite's floor comes from the contract. The country list stays as it is for direct customers.

**Stripe Connect**
- Already used for WeldApps payouts (`app_developer_accounts`, `resolveConnectSplit`).
- Not needed here, because the money flows reseller → WeldSuite, not the other way.

**App access is enforced only in the browser**
- `AppAccessGuard` redirects; `workspace_installed_apps` lives in the tenant DB.
- Module workers (`createModuleApi` / `apiAuth()` in `packages/core/worker-kit/src/app.ts`) **never check whether an app is installed**. A workspace that does not have WeldDesk can still call `desk-api`.
- `POST /api/app-catalog/:code/install` lets any OWNER or ADMIN install any published app.
- **So a licence that leaves out an app is advisory until this gate exists.**

**Credits**
- `packages/core/credits` is a solid engine: atomic `consumeCredits`, idempotent `grantCredits`.
- The monthly allowance is **added on top** of the balance on each Stripe `invoice.paid`. It has no reset, no expiry, and `rolloverCap` is never enforced. There is no cron.
- **A workspace OWNER can grant their own workspace credits.** `POST /api/credits/adjust` and `/subscription` in `apps/workers/app-api/src/routes/credits/index.ts` only require `billing:manage`, which OWNER holds. This must be closed before credits can be licensed, and is worth fixing for every workspace anyway (see "Issues found along the way").

**Other limits**
- Seats are enforced, with Clerk `max_allowed_memberships` as the backstop.
- Storage, projects and custom domains are display-only.

## Concepts

- **Partner**: the reseller company. It has its own team of portal users and its own Stripe customer. It is not a workspace.
- **Partner contract**: the commercial terms for one partner, effective-dated:
  - revenue share (WeldSuite's part, 75%);
  - base minimum per workspace;
  - currency;
  - payment terms.
- **Managed workspace**: a normal workspace (own Clerk org, own tenant DB) with `partner_id` set. WeldSuite does not bill it directly.
- **Licence**: what one managed workspace may use and what the reseller charges for it:
  - apps;
  - monthly credits;
  - seat cap (optional);
  - resale price (flat or per seat).
- **Licence package**: a reusable template the reseller defines, for example "Service desk: WeldDesk + WeldCRM, 3,000 credits, $199 flat". A workspace's licence starts from a package and can be overridden.
- **Statement**: the monthly calculation of what the partner owes, one line per workspace. It is the source of the Stripe invoice sent to the partner.

## The money

### What WeldSuite charges per workspace, per month

```
resale        = flat_amount                                  (flat)
              | unit_amount × max(billable_seats, min_seats)  (per seat)

weldsuite_due = max(resale × revenue_share, base_minimum)
              + extra credit packs granted this month        (see Credits)

partner_keeps = resale − weldsuite_due
```

**Defaults**
- `revenue_share` is 0.75. It is stored as basis points (`7500`) on the contract, not in code.
- `base_minimum` is set per contract, in the contract currency.

**Billable seats**
- The highest active member count seen in the month.
- A daily sweep takes a snapshot of the member count; see Phase 2.
- The peak is used, not the last day, so a workspace cannot remove members on the 30th and add them back on the 1st.

**Partial months**
- Licence changes and workspaces created or ended mid-month are prorated by day.
- Each day is charged under the licence that was in force that day; the history table below makes this possible.

**Worked examples** (contract: 75%, $50 floor):

| Workspace | Reseller charges | 75% | WeldSuite bills | Reseller keeps |
|---|---|---|---|---|
| Acme (flat) | $400 | $300 | **$300** | $100 (25%) |
| Beta (per seat, $12 × 5) | $60 | $45 | **$50** (floor) | $10 |
| Gamma (flat, trial at $0) | $0 | $0 | **$50** (floor) | −$50 |

The floor is what protects WeldSuite against a reseller giving workspaces away.
The third row is deliberate: a free trial for a customer costs the reseller the
floor. If trials should be free, the contract gets a trial allowance; see Open
decisions.

### Credits carry a real cost, so the floor should follow them

Credits are spent on AI (Cloudflare AI Gateway), telephony, OCR and similar
services, and every one has a hard cost to WeldSuite. With only a flat floor, a
reseller could license 1,000,000 credits at $50 and WeldSuite would lose money.

**Recommendation:** the contract has two parts.
- `included_credits`: credits covered by the base minimum, e.g. 2,000.
- `credit_floor_price`: e.g. $0.004 per credit above that.

The floor then becomes:

```
base_minimum + max(0, licensed_credits − included_credits) × credit_floor_price
```

The 75% share still applies on top. If the reseller charges enough, the floor
never bites. Setting `credit_floor_price = 0` gives exactly the simple floor
agreed above, so the schema supports both and the contract decides.

### Recording the price (the reseller's 25%)

The resale price is a **required** field of every licence. The portal shows
three numbers per workspace and in total:
- customer price;
- WeldSuite share;
- partner margin.

Every change is kept in `workspace_licence_changes` with who made it and when,
so a statement can always be rebuilt and both sides can audit it.

**Trust:** the reseller self-reports the price. That is a contract matter (audit
clause). The design keeps an exact history, so an audit is a query, not an
argument. A later option is to let the reseller invoice their customers through
WeldBooks; the recorded price would then be the invoiced price.

### Currency and tax

- **Currency:** one contract currency, USD by default. Resale prices are recorded in it.
  - A reseller selling in BRL or MXN converts on their side.
  - FX is the reseller's risk, and WeldSuite never needs an exchange rate.
- **Tax:** the reseller is WeldSuite's only customer for these workspaces, so tax on WeldSuite's invoice is a B2B question between WeldSuite and the reseller's entity. The reseller handles tax towards their own customers. Confirm the VAT treatment with the accountant; `accounting-nl` and `accounting-us` can help.

### Collecting the money

**Monthly statement run (billing-worker cron, 1st of the month)**
1. Freeze the previous month's statement.
2. Create Stripe invoice items on the partner's Stripe customer, one line per workspace.
3. Finalise a Stripe invoice with `collection_method: send_invoice` and net terms from the contract (e.g. 30 days), or charge a card on file.
4. Existing `invoice.*` webhooks already record invoices in `billing_invoices`. Add `partner_id` so they show in the portal.

**Unpaid invoices**
1. Reminders.
2. After the contract's grace period, the partner is `past_due`. Its workspaces get a banner, but nothing is blocked yet.
3. After a second period, workspaces go **read-only**, never deleted. The decision belongs to WeldSuite staff, in admin, not to a cron alone.

**What end customers see**
- A managed workspace never sees WeldSuite pricing, checkout, upgrade buttons or invoices.
- Settings > Billing shows "Your subscription is managed by {Partner}" with the partner's contact details, plus the licence (apps, credits used this month, seats).

## Licence model

A licence answers "what may this workspace use?" These columns are available:

| Field | Meaning | Enforced by |
|---|---|---|
| `allowed_apps` | App codes from `app_catalog` (`weldcrm`, `welddesk`, …), or `*` for everything | New server-side app gate (below) + install route |
| `monthly_credits` | Allowance granted each period | Credit sweep (reset) + existing `consumeCredits` (hard stop at 0) |
| `credit_rollover` | `none` (default) or a cap | Credit sweep |
| `max_seats` | Optional cap. Null = unlimited, and with per-seat pricing every seat is billed. | Existing seat limit + Clerk cap |
| `feature_plan_id` | Which `plans` row supplies feature limits (WeldMail addresses, API access, branding removal, task executions) | Existing plan-limit checks, unchanged |
| `storage_gb` | Optional | **Not enforced anywhere today.** Recorded now, enforced in Phase 4 |
| `resale_pricing` | `{ model: 'flat' \| 'per_seat', amount, min_seats? }` | Statements only |

`feature_plan_id` reuses everything that already reads `plans.features`, so
there is no second limit system. A reseller picks a package. Behind that
package, WeldSuite staff decide which feature plan each package may reference.
By default every partner package uses `business`. The partner contract can
allow `scale` or `enterprise`.

## Data model (master DB)

**Proposed. Per CLAUDE.md, no migration is written until approved.**

**`partners`**
- `id` (`ptr_`), `name`, `legal_name`, `country`, `tax_id`.
- `billing_email`, `support_email`, `support_url`, `logo_url` (shown to end customers).
- `stripe_customer_id`.
- `status` (`active` | `past_due` | `suspended`).
- `created_at`.

**`partner_members`**
- `partner_id`, `user_id` (master `users`), `role` (`owner` | `admin` | `billing` | `viewer`).
- Unique on (`partner_id`, `user_id`).

**`partner_contracts`** (effective-dated, never edited in place)
- `partner_id`, `effective_from`, `effective_to`.
- `currency`.
- `revenue_share_bps` (7500), `base_minimum` (numeric).
- `included_credits`, `credit_floor_price`, `extra_credit_pack_price`.
- `allowed_feature_plan_ids` (jsonb), `payment_terms_days`.
- `trial_days_free` (default 0), `territory` (jsonb list of ISO-2 codes, informational).
- `notes`.

**`partner_licence_packages`**
- `id` (`plp_`), `partner_id`, `name`.
- `allowed_apps`, `monthly_credits`, `max_seats`, `feature_plan_id`, `storage_gb`.
- `default_resale_pricing`, `is_archived`.

**`workspace_licences`** (one row per managed workspace)
- `workspace_id` (unique), `partner_id`, `package_id` (nullable).
- `allowed_apps`, `monthly_credits`, `credit_rollover`, `max_seats`, `feature_plan_id`, `storage_gb`.
- `resale_pricing`, `status` (`trial` | `active` | `suspended` | `ended`).
- `starts_at`, `ends_at`, `updated_by`, `updated_at`.

**`workspace_licence_changes`**: an append-only snapshot of the full licence after each change, with `changed_by`, `changed_at` and `reason`. Statements prorate from this table.

**`workspace_seat_snapshots`**: `workspace_id`, `date`, `active_members`, written by the daily sweep. The peak per month is the billable seat count.

**`partner_statements`**
- `partner_id`, `period_start`, `period_end`, `currency`.
- `status` (`draft` | `final` | `invoiced` | `paid` | `void`).
- `totals` (resale, due, margin).
- `stripe_invoice_id`, `contract_snapshot` (jsonb).

**`partner_statement_lines`**
- `statement_id`, `workspace_id`, `days_active`.
- `resale`, `share_amount`, `floor_amount`, `credit_floor_amount`, `extra_credits_amount`, `due`.
- `licence_snapshot`, `seats_billed`.

**On `workspaces`**
- `partner_id` (nullable FK).
- `billing_mode` (`direct` | `partner`, default `direct`).

**On `billing_invoices`**
- `partner_id` (nullable), so a partner invoice is not tied to a workspace.

**Why master, not tenant**
- The partner portal reads across many workspaces.
- Enforcement must be cheap. The licence joins the cached workspace context the kit already loads (`getWorkspaceContextForOrg`), not a tenant query on every request.

## Enforcement

### App access gate (server-side, new)

Add a `licenceGate()` middleware to `@weldsuite/worker-kit` and put it in `apiAuth()` after `workspaceDbMiddleware()`. Flow:

1. `getWorkspaceContextForOrg` already returns `{ db, suspended }` from a KV-cached record. Extend that record with `billingMode` and `allowedApps`. The licence write path invalidates the workspace KV entry; the TTL is the fallback.
2. Map the request path to its module with the existing `@weldsuite/api-modules` index (`findModuleForPath`, longest prefix wins). Then map module → app code. Add an `appCode` field to each module definition, e.g. `desk` → `welddesk`, `pass` → `weldpass`.
3. Decide:
   - If `billingMode === 'partner'` and the app is not licensed, return `403 { error: { code: 'APP_NOT_LICENSED', message, details: { app } } }`.
   - Core paths (app-api: settings, members, files, search, notifications) are always allowed.
4. Direct workspaces pass straight through in v1. The same gate can later enforce plan-based app access for direct customers, by filling `allowedApps` from the plan instead of a licence.

The gate goes into every module worker at once, because they all use `apiAuth()`. **app-api's forwarder runs before auth**, so forwarded calls are checked in the module worker. external-api (wsk_ keys) and the mcp-server need the same check through their own auth middleware.

### Installed apps follow the licence

- `POST /api/app-catalog/:code/install` refuses an unlicensed app (`APP_NOT_LICENSED`).
- When a licence changes, app-api applies it to tenant `workspace_installed_apps`. It reuses `services/app-catalog.ts` install and uninstall, both soft and reversible:
  - newly licensed apps are installed;
  - removed apps are set `isActive=false`.
  - No data is deleted: re-licensing brings the app back with its data.
- App Store UI in a managed workspace: unlicensed apps show "Ask {Partner} to add this app" instead of Install.

### Credits

**A partner credit sweep** (billing-worker cron, daily, idempotent per workspace and period) replaces the Stripe-invoice-driven grant for managed workspaces:
- At period start, set `monthlyAllocation` and `planCredits` to the licence's `monthly_credits`.
- Grant up to the allowance with idempotency key `partner_grant:{ws}:{periodStart}`.
- **Expire** the unused balance beyond the rollover cap with a negative `adjustment` (`credit_rollover_expired`), so "resets monthly" is true.
- Purchased extra packs (below) are tracked as a separate transaction type and never expire.
- The period is the calendar month in UTC, matching the statement.

**Licence changes mid-month**
- An increase grants the difference now. This mirrors the existing upgrade path in `billing-worker/src/services/credits.ts:87`.
- A decrease takes effect at the next reset.

**Extra credits.** When a workspace runs out, the end customer cannot buy credits from WeldSuite; the top-up checkout is hidden and the route refuses partner workspaces. The reseller grants an **extra credit pack** from the portal:
- It lands immediately.
- It is billed on that month's statement at the contract's `extra_credit_pack_price`.

**Running out**
- `consumeCredits` already hard-stops at 0 with `INSUFFICIENT_CREDITS` (402).
- The platform shows "Your credits for this month are used up. Contact {Partner}."
- **Fix the fail-open in `assertAiCredits`** (`packages/domains/core/src/ai-billing.ts:100`) for partner workspaces. An outage must not turn into unlimited AI on WeldSuite's bill.

**Prerequisite:** close the self-grant routes. `POST /api/credits/adjust`, `/subscription`, `/consume`, `/refund` and `/allocate-monthly` move behind the billing-worker admin secret, or are deleted where unused. Workspace users keep the read routes.

### Seats

- When the licence sets `max_seats`, the seat limit for a managed workspace is `max_seats` instead of the plan-based value.
- `services/seat-limits.ts` and `trySyncClerkSeatLimit` gain one branch, and the Clerk cap does the rest.
- Without `max_seats`, seats are unlimited and, with per-seat pricing, billed at the monthly peak.

### Feature limits

Unchanged code. A managed workspace's `planId` is set to the licence's `feature_plan_id`, so every existing `plans.features` check keeps working.

The paywall fields (`paidPlanRequired`, trial expiry, pay-or-delete) are ignored when `billing_mode = 'partner'`. Payment is the partner's problem, handled through partner status, not per workspace.

## Provisioning a managed workspace

From the partner portal: **New workspace**. Fields:
- workspace name;
- country and region (reuses the onboarding defaults);
- customer owner's email;
- licence package and price.

1. app-api `POST /api/partner/workspaces` calls workspace-worker `/onboard`, the same path as self-signup, with `billingMode='partner'`, `partnerId` and the licence.
2. In the `ProvisionWorkspace` workflow:
   - `install-apps` uses the licence's apps;
   - `initialize-credits` uses the licence's credits;
   - **`setup-billing` is skipped**: no Stripe customer and no $0 subscription for the workspace.
3. The customer's owner gets the normal invite email.
   - The partner user who created the workspace is **not** added as a member.
   - Optional support access is a separate, consented feature (Phase 4).

**Moving an existing direct workspace to a partner** (admin only):
1. Cancel its Stripe subscription at period end, or immediately with credit for the unused time.
2. Set `partner_id` and the licence.
3. Never the reverse without staff.

**Moving a workspace back to direct, or ending a licence:** the workspace falls back to the normal paywall flow (`paidPlanRequired`), with a grace period, and keeps its data.

## Partner portal (platform SPA)

A new top-level area at `/partner`, shown only to users in `partner_members`. Components live in `apps/web/platform/app/partner/`, route wrappers in `src/routes/partner/`. It runs in the platform shell but is **not scoped to a workspace**: a partner user may also belong to zero or many workspaces.

| Page | Contents |
|---|---|
| Overview | Active workspaces, this month's resale total, WeldSuite share, partner margin, credits used vs licensed, workspaces near their credit limit |
| Workspaces | Table with name, customer owner, package, price model, seats, credits used, status. Actions: create, edit licence, suspend or end licence, grant extra credits |
| Workspace detail | Licence editor with live "WeldSuite bills / you keep" preview, licence history, seat and credit usage chart |
| Packages | Create, edit and archive licence packages |
| Statements | Current month preview (live), past statements with lines, Stripe invoice PDF and pay link, CSV export so the reseller can invoice their own customers |
| Team | Partner members and roles |
| Settings | Company details, support contact shown to customers, logo |

**Backend**: `apps/workers/app-api/src/routes/partner/`, a new core-platform object, plus services in `src/services/partner/`. Register the `/api/partner` prefix with core in `packages/core/api-modules`.

Partner routes use `clerkMiddleware()` and a new `partnerAuth()`:
- it resolves `partner_members` for the user and checks a partner role;
- it does **not** use `workspaceDbMiddleware`;
- it reaches a managed workspace's tenant DB only through the master lookup, and only for workspaces with that `partner_id`.

**Partner permissions** are a separate small set, not `weld*` workspace permissions:

| Permission | Roles |
|---|---|
| `partner:workspaces:read` | all |
| `partner:workspaces:manage` | owner, admin |
| `partner:licences:manage` | owner, admin |
| `partner:billing:read` | owner, admin, billing |
| `partner:team:manage` | owner |

**Audit trail:** every licence change, credit grant and workspace creation publishes an entity event (`partner_workspace`, `workspace_licence`; add both to the catalog), as CLAUDE.md requires for mutations.

**i18n:** every new string in `en` and `nl`. Spanish and Portuguese matter for this reseller. `es` exists but is partial; `pt` would be new. That is a separate decision.

## Admin console (`apps/web/admin`)

- **Partners list and detail.** Create a partner, invite its first owner, edit the contract (new effective-dated row), set status.
- **Partner workspaces.** See and override any licence, with an audit trail in the existing `admin_audit_events`. Move a workspace in or out of a partner.
- **Statements.** Preview, re-run a draft, void, and see Stripe status.
- **Actions.** Server actions go to billing-worker `/api/internal/admin/partners/*` with `x-admin-secret`, like the existing admin billing actions.

## Phases

**Phase 0: prerequisites** (worth doing even without resellers)
1. Close the credit self-grant routes.
2. Add the server-side app gate in worker-kit, external-api and mcp-server. Enforce it for partner workspaces only.
3. Add `appCode` to `@weldsuite/api-modules`.

**Phase 1: partner and licence, admin-managed**
1. Schema (after migration approval): partners, contracts, packages, licences, history, `workspaces.partner_id` / `billing_mode`.
2. Admin console: create partners, managed workspaces and licences.
3. Provisioning with licence, skipping `setup-billing`.
4. Licence → installed apps sync, credit sweep with reset, seat cap.
5. Managed-workspace billing page ("managed by {Partner}").

At the end of this phase, WeldSuite staff can run the reseller deal by hand.

**Phase 2: statements and invoicing**
1. Seat snapshot sweep.
2. Statement calculation with daily proration.
3. Monthly Stripe invoice to the partner; extra credit packs on the statement.
4. Partner `past_due` / `suspended` handling.

**Phase 3: partner portal**
1. `/api/partner/*` routes with `partnerAuth()`.
2. Portal pages, packages, the live price preview, statements, CSV export.
3. Team management.
4. Help docs (`apps/web/docs`) for partners.

**Phase 4: later**
- Support access: a partner user joins a customer workspace with the customer's consent, time-boxed and audited.
- Storage enforcement (for everyone).
- Partner API (`wsk_`-style keys with `partner:*` scopes on external-api) for automated provisioning.
- White-label: partner logo and domain on the login page and app shell.
- Plan-based app gating for direct customers through the same gate.
- WeldBooks invoicing for the reseller's own customers.

## Open decisions

The owner needs to answer these. Each has a recommendation.

1. **Does the floor grow with licensed credits?** Recommended: yes (`included_credits` + `credit_floor_price`). Otherwise credits are WeldSuite's uncapped cost.
2. **Contract currency.** Recommended: USD, with resale prices recorded in USD.
3. **Free trials.** Should a workspace in `trial` cost the floor? Recommended: `trial_days_free` on the contract (e.g. 14 days), after which the floor applies even at a $0 price.
4. **Per-seat basis.** Recommended: peak active members in the month, with optional `min_seats`. Alternative: members on the last day of the month.
5. **Unpaid partner.** Recommended: reminders, then banner after N days, then read-only after M days, with staff confirmation before read-only. N and M are on the contract.
6. **Territory.** Should people who sign up directly from the Americas be pointed to the reseller, or is the territory informational only? Recommended: informational in v1, no signup routing.
7. **Languages.** Is a Spanish/Portuguese platform in scope for this deal?
8. **Should partner users see their customers' data?** Recommended: no by default, with consented support access in Phase 4.

## Issues found along the way (independent of this feature)

These turned up in the survey and stand on their own:

1. **Credit self-grant.** `POST /api/credits/adjust` and `/subscription` (`apps/workers/app-api/src/routes/credits/index.ts:523,573`) only need `billing:manage`, which every workspace OWNER has. An owner can grant their own workspace unlimited credits. **Fix now** (Phase 0, item 1).
2. **Uninstalled modules stay usable through the API.** Only the browser checks installs (`AppAccessGuard`). Phase 0, item 2 fixes this for partner workspaces; direct customers are unaffected until plans gate apps.
3. **AI credit check fails open** when metering is unavailable (`packages/domains/core/src/ai-billing.ts:100`).
4. **Seat cap may double-count included users.** The Clerk cap is `includedUsers + purchasedSeats`, while checkout's quantity is the total seat count (`apps/workers/app-api/src/services/billing.ts:44-68` vs `routes/billing/index.ts:662-681`).
5. **Admin `changeSubscription` ignores country prices.** It uses the plan row's default Stripe price (`apps/workers/billing-worker/src/services/admin-billing.ts:541`), not the per-country price that checkout uses.
6. **Monthly plan credits never expire or cap.** They are added on top at each `invoice.paid`, and `rolloverCap` is never enforced (`apps/workers/billing-worker/src/services/credits.ts:32-113`).
