# EU billing: plans and seats on Mollie

Status: **draft for review** (2026-11-14). Proposed in ADR BILL-014
(`weldsuite-documentation`, `adr/BILL-014-eu-edition-bills-plans-and-seats-through-mollie.md`).
Nothing here is built, and nothing here changes Global. It builds on BILL-013
(credit top-up through Mollie, weldsuite/weldsuite#1570, not merged yet). The
schema changes below need approval before any migration is written.

## What BILL-014 proposes, in short

- The EU edition (and any Kubernetes install that sets `BILLING_PROVIDER=mollie`)
  sells plans and seats through Mollie. Self-hosted installs keep the licence
  file. Global keeps Stripe.
- **Our own scheduler charges Mollie mandates.** The Mollie Subscriptions API
  is not used. The master DB is the only record of plan, seats and status.
- **Invoice first, then charge.** WeldBooks, in WeldSuite's own workspace on
  the EU edition, issues every invoice with the right VAT. The invoice is
  mirrored into master `billing_invoices`.
- **Upgrades take effect at once, against a prorated charge. Downgrades wait
  for the period end.**
- **Our own dunning:** retries on days 3, 7 and 14, emails with a pay link,
  then Free.
- **Same `/api/billing/*` API as app-api**, served by the Rust backend, with a
  few platform changes where Mollie works differently from Stripe.

## Where we start

- `billing`, `credit-top-up` and `paid-apps` are in `UNAVAILABLE_FEATURES`
  (`rust/bins/weldsuite/src/edition.rs`). So are `phone-number-purchase` and
  `domain-purchase`. The Rust `domain-auto-renew` cron does nothing, as the
  worker does without `STRIPE_SECRET_KEY`.
- The Rust backend serves **no** `/api/billing/*` route. app-api serves them on
  Global (`apps/workers/app-api/src/routes/billing/index.ts`) and calls Stripe
  directly. billing-worker owns the webhooks, phone, credits, WeldReach, SSO
  and apps billing, the admin API and the hourly sweeps.
- The Rust backend does serve `/api/member-limits` and `/api/prepaid-seats`,
  and the invite route's seat check (`rust/modules/core-team/src/groups/seats.rs`).
  They read `plans` and `workspaces.purchased_seats` from master, as on Global.
- On Zitadel the membership cap is stored as organization metadata
  (`weldsuite.max_memberships`) and **not enforced**
  (`rust/crates/adapters-oss/src/zitadel.rs`). Invitations are created only by
  WeldSuite's invite route, and pending ones count against the limit.
- PR #1570 adds `rust/modules/core-platform/src/topup/`:
  - `mollie.rs`: Payments API v2 over the outbound HTTP port. It has `Money`,
    `Payment`, create and get, idempotency keys and `is_payment_id`.
  - `ledger.rs`: the wallet writes, in transactions.
  - `mod.rs`: `/api/credits/checkout`, `GET /api/credits/checkout/:id`, and
    `POST /api/webhooks/mollie`, which reads the payment back and dispatches
    on `metadata.kind = credit_topup`.
  - Settings: `MOLLIE_API_KEY`, `MOLLIE_API_URL`, `MOLLIE_WEBHOOK_URL` and
    `MOLLIE_REDIRECT_URL`.
- WeldBooks is ported (`rust/modules/books-sales`, `rust/crates/books-domain`):
  - invoices, credit notes, payments, PDFs (`invoices/pdf.rs`) and numbering
    per accounting entity;
  - VIES checks, cached in `vies_checks`, and the Dutch reverse-charge notice
    (`compliance.rs`);
  - a system-user path, `generate_recurring_invoice_as_system`, which the
    books sweep uses.
- The platform's billing page (`apps/web/platform/app/settings/billing/`) uses
  `useSubscription`, `useInvoices`, `usePlanLimits`, `usePhoneSubscription`,
  the credit hooks, cancel and reactivate. Payment methods use **Stripe
  Elements** against a SetupIntent (`payment-methods-section.tsx`). The plans
  page calls `/billing/plans-page` and `/billing/checkout`. The invite dialog
  buys seats through `/billing/seats`.

## Design

### Settings and the feature gate

| Setting | What it does |
|---|---|
| `BILLING_PROVIDER=mollie` | Turns plan billing on. Needs `MOLLIE_API_KEY`. |
| `MOLLIE_API_KEY`, `MOLLIE_WEBHOOK_URL` | BILL-013's settings: one key and one webhook for every Mollie payment. |
| `BILLING_ISSUER_WORKSPACE_ID`, `BILLING_ISSUER_LEGAL_ENTITY_ID` | The workspace whose WeldBooks issues the invoices, and the legal entity (WeldSuite B.V.) inside it. |
| `BILLING_PAY_LINK_KEY` | Signs the pay links in dunning emails. A secret in `weldsuite-env`. |
| `BILLING_RETURN_URL` | Where checkouts return. Default `<PUBLIC_APP_URL>/settings/billing`. |

`BILLING_PROVIDER=mollie` without a key, an issuer, or a usable webhook and
return URL is a start problem, as BILL-013's `TopUpSettings::from_lookup`
already treats its settings. With billing configured, `edition.rs` drops
`billing` from `unavailableFeatures`, the way `mail-domains` follows
`MAIL_MX_HOST`. `/config.json` gains `billingProvider: "mollie"` (absent on
Global), which is the only switch the platform reads for the changes below.

The chart adds a `cron.jobs.billing-renewals` entry (hourly) and the secret
key. The EU cluster settings set `BILLING_PROVIDER` and the issuer ids.

### Data model (needs approval, no migration yet)

Master DB, through the Drizzle schema (`packages/core/db/src/schema/master.ts`)
and `db:generate:master` once approved:

| Table | Change |
|---|---|
| `billing_accounts` (new) | One row per workspace that has ever checked out. `workspace_id` (unique), `provider` (`mollie`), `customer_id` (`cst_…`), `mandate_id` (`mdt_…`, the default), `mandate_method` (`creditcard`, `directdebit`), `mandate_label` (masked only: "Visa •••• 4242", "NL•• … 1234"), `anchor_day` (1–28), `next_charge_at`, `scheduled_plan_id`, `scheduled_seats`, `scheduled_cycle`, `dunning_attempt`, `dunning_next_at`, `collection` (`mandate`; `invoice` later), timestamps. Index on `next_charge_at` and on `dunning_next_at`. |
| `billing_invoices` | Add `provider` (`stripe`, `weldbooks`) and `provider_invoice_id` (the WeldBooks invoice id). Make `stripe_invoice_id` nullable: it is `NOT NULL UNIQUE` today. Add `lines` (jsonb: what was billed, with periods and proration), `due_at`, and `pdf_file_key` (the copy in the customer workspace's files). |
| `billing_payments` | Add `provider`, `provider_payment_id` (unique, `tr_…`) and `kind` (`first`, `renewal`, `proration`, `retry`, `pay_link`). |
| `workspaces` | No change. `plan_id`, `purchased_seats`, `subscription_status/cycle/current_period_*` and `subscription_cancel_at_period_end` are already provider-neutral. Rust leaves `stripe_*` empty. |
| `plans` (data) | EU rows for `free`, `business`, `scale` and `enterprise`, in EUR. Paid plans get `included_users = 0`, so `included_users + purchased_seats` is exactly the number of seats billed. |

In the issuer workspace's tenant DB, the rows are ordinary WeldBooks rows: one
customer contact per paying workspace (keyed by `workspaces.id` in the
contact's reference), invoices, credit notes and payments.

### Plans and prices (BILL-007)

- BILL-007 holds unchanged. Paid plans are "On request" unless staff priced
  them for the workspace's billing country, in the EU master's
  `system_settings.billing.plan_country_pricing`. The resolver
  (`@weldsuite/app-api-client/schemas/plan-country-pricing`) is ported to Rust
  and checked by conformance against app-api.
- **EUR only.** A country priced in another currency is refused at checkout
  (400), never converted, as BILL-013 does for packages. SEPA Direct Debit is
  EUR-only anyway.
- Prices are shown and stored without VAT. VAT is added on the invoice.
- BILL-004 holds: Free is one seat (`max_users = 1`), with no trial, no card
  and no Mollie customer. Nobody on the EU master has `paid_plan_required`,
  so the pay-or-delete window exists in code but never arms there.
- Enterprise stays "custom". Staff set plan and seats and invoice by hand
  (WeldBooks, bank transfer) until collection by invoice is built.

### Seats and the seat gate (BILL-003 on Zitadel)

- The hard gate is the invite route's check, which already counts members plus
  pending invitations against the limit. Zitadel can't be the gate: it doesn't
  enforce the cap. A Zitadel invitation is a user grant that the invite route
  creates, so no invitation exists outside that check. The only way past it is
  a staff member adding a grant in the Zitadel console, and identity sync
  should log that as over the cap. It shouldn't remove anyone.
- The cap is still written to `weldsuite.max_memberships` whenever plan or
  seats change, so `/api/member-limits` and the cap stay consistent.
- `POST /api/billing/seats` refuses a decrease below members plus pending
  invitations. app-api counts only members, so Global's check should probably
  count invitations too (a follow-up, not this plan).
- Plan caps: Business allows 1–10 seats, so an eleventh seat needs Scale. The
  route answers with the same message as app-api's `getPlanSeatCapViolation`.

### Checkout: the first payment

`POST /api/billing/checkout` (`billing:manage`), with app-api's body
`{ planId, seats, cycle, successUrl?, cancelUrl? }`:

1. Refuse when billing details are missing: country, company name, address,
   and the VAT number for a business. The answer is 400
   `BILLING_DETAILS_REQUIRED`, and the plans page opens the existing
   billing-details dialog. Stripe Checkout collected these itself; Mollie's
   hosted checkout doesn't.
2. Resolve the price (BILL-007), the VAT treatment (below) and the period
   (now, until one month or one year later). The anchor day is today's day of
   the month, capped at 28.
3. Create the Mollie customer if the workspace has none: name, email of the
   billing owner, locale, and `metadata.workspaceId`. Store it in
   `billing_accounts`.
4. Issue the invoice through `InvoiceIssuer` (open, due now).
5. Create a payment with `sequenceType: first`, `customerId`, the invoice total
   VAT included, `description` = the invoice number, and metadata
   `{ kind: "billing_first", purpose: "checkout", workspaceId, invoiceId, paymentRowId }`.
   The idempotency key is the payment row's id.
6. Answer `{ data: { url } }`: Mollie's hosted checkout. The customer returns
   to `successUrl` with `checkout=<paymentRowId>` added, and the page asks
   `GET /api/billing/checkout/:id`, as BILL-013's return page does.

When the payment is paid (webhook or return page, idempotent):

- Mark the invoice paid in WeldBooks and in the mirror.
- Store the new mandate (from `payment.mandateId`) as the default.
- Set `plan_id`, `purchased_seats`, `subscription_status = active`, cycle and
  period, and `next_charge_at`.
- Write the seat cap.
- Grant the plan's monthly credits, idempotent on workspace and period start,
  as Global's `updateSubscriptionCredits` does.

A failed or expired first payment changes nothing, and the invoice is credited
in full so it doesn't stay open (credit note). Whether that should be a credit
note or a void draft is an open question for the accountant.

### Renewals and the anchor

`weldsuite cron billing-renewals`, hourly. It reads master only, so no tenant
DB wakes up except the issuer's (DATA-008).

1. Claim accounts with `next_charge_at <= now()`, with
   `FOR UPDATE SKIP LOCKED`, so overlapping runs never charge twice.
2. Skip a comped workspace (`isCompActive`, BILL-011). For a comp, the job
   only renews the monthly plan credits and ends a comp whose `comp_ends_at`
   has passed: what billing-worker's comp sweep does on Global. There is no
   Mollie subscription to cancel when a comp starts.
3. Apply what is scheduled for the period end (plan, seats, cycle,
   cancellation). Cancellation ends the subscription:
   `applySubscriptionEnded`, Free.
4. Build the lines that are due on this anchor:
   - the plan, for a monthly plan or a yearly anniversary;
   - the monthly add-ons, once they move onto Mollie.
5. Issue the invoice, then create a recurring payment (`sequenceType: recurring`,
   `mandateId` = the default) with
   `metadata { kind: "billing_charge", purpose: "renewal", … }`.
6. Move the period and `next_charge_at` forward when Mollie accepts the
   payment (`paid`, or `pending` for SEPA Direct Debit). A refusal goes to
   dunning.
7. Grant the monthly plan credits on every anchor. For a yearly plan that is
   each month, as the comp sweep does for comps.

An invoice that was issued but never charged (Mollie was down) is charged on
the next run. The payment row is keyed on the invoice id, so no second invoice
is made.

### Upgrades, downgrades and proration

| Change | When | Charge |
|---|---|---|
| More seats | At once, granted when Mollie accepts the payment | Prorated: added seats × seat price × days left / days in period |
| Business → Scale, or any dearer plan | At once | Prorated: (new period total − old period total) × days left / days in period |
| Fewer seats | At the period end (`scheduled_seats`) | None; the next renewal bills the lower number |
| Cheaper plan, or Free | At the period end (`scheduled_plan_id`). `validate-downgrade`'s blockers apply | None |
| Monthly ↔ yearly | At the period end (`scheduled_cycle`) | The next renewal bills the new cycle |
| Cancel / reactivate | `subscription_cancel_at_period_end` | None |

Days count in UTC, with today included in "days left". Each line is rounded to
the cent, half up, before VAT. The charge is its own invoice, with the period
the proration covers.

Example, at a placeholder price of €49 per seat per month: 3 → 5 seats on day
11 of a 30-day period is 2 × €49 × 20 / 30 = €65.33, before VAT.

`POST /api/billing/seats` keeps app-api's answer
`{ purchasedSeats, paymentRequired?, paymentUrl? }`:

- When Mollie accepts the charge: the new `purchasedSeats`.
- When the mandate can't be charged (revoked, or the card expired):
  `paymentRequired: true`, and a `paymentUrl` to a hosted checkout for the
  prorated invoice. That checkout is a first payment, so it also renews the
  mandate.
- For a decrease: the current `purchasedSeats`, plus the new
  `effectiveAt` field, so the UI can say "from <date>". The field is
  additive.

Nothing is refunded or credited for part of a period (BILL-014, decision 6).
Global credits a seat decrease at once, so this is a deliberate difference.

### Failed payments and dunning

| Day | What happens |
|---|---|
| 0 | The renewal charge fails or expires. `subscription_status = past_due`, `dunning_attempt = 1`. The billing owners get an email with the invoice and a pay link. The billing page shows the open invoice and its pay link. |
| 3 | Retry on the mandate. If it fails, email. |
| 7 | Retry. If it fails, email: "last notice before the plan ends". |
| 14 | Last retry. If it fails, the subscription ends: `applySubscriptionEnded`, Free (the seat cap drops to 1; members stay, but nobody new can join), and an email. |

- **Pay link:** `GET /public/billing/pay/<token>`. The token is signed with
  `BILLING_PAY_LINK_KEY`, names the invoice, and expires. The route creates a
  Mollie payment for the open amount (a first payment, so it also renews the
  mandate) and answers 303 to the checkout. It needs no sign-in, because it is
  in emails, like Stripe's hosted invoice page. The mirror's `hosted_url` holds
  it, so the billing page links it unchanged.
- **Paying ends dunning:** the invoice is paid, `past_due` goes back to
  `active`, `next_charge_at` stays on the anchor, and the retries are cleared.
- **SEPA Direct Debit:** a charge sits at `pending` for some business days.
  When the webhook later reports `failed`, it enters dunning at day 0. A
  chargeback (`amountChargedBack`) on a paid invoice reopens it and enters
  dunning. Plan credits already granted are not clawed back. Top-ups are
  (BILL-013).
- Mollie retries only its own subscriptions' payments, so it doesn't fight
  this schedule. Phase 0 confirms that.
- The emails are new templates in `packages/core/emails` (en/nl): payment
  failed, final notice, plan ended, invoice. They are sent through the EU MTA
  (MAIL-011), with the Rust side filling the pre-rendered HTML.

### Invoices and VAT

WeldSuite B.V. is Dutch, and a WeldSuite plan is an electronically supplied
service. `vat_treatment(billing details, VIES result)` decides each invoice:

| Customer | Treatment | On the invoice |
|---|---|---|
| In the Netherlands, business or consumer | 21% NL VAT | Standard |
| EU business outside NL, VAT number valid in VIES | 0%, reverse charge | The customer's VAT number and the reverse-charge text (`NL_NOTICE_REVERSE_CHARGE_EU`). Listed in the Opgaaf ICP. |
| EU business outside NL, VAT number invalid or VIES down | Refused at checkout until VIES confirms, or treated as a consumer (open question 2) | Nothing is issued until it is settled |
| EU consumer outside NL | The customer's country rate, through OSS | Needs the BV registered for OSS, and location evidence: billing country plus network country |
| Outside the EU | No Dutch VAT (outside scope) | "VAT reverse charged / not subject to Dutch VAT" |

The `InvoiceIssuer` trait has a WeldBooks adapter:

1. Upsert the customer contact in the issuer workspace: name, address, VAT
   number, email, and the reference `workspaces.id`.
2. Create the invoice from the lines, with the tax rate per treatment.
   Finalize it (number, ledger posting, VIES notice) as the system user, the
   way `generate_recurring_invoice_as_system` runs the route's steps.
3. Render the PDF and copy it to the customer workspace's files
   (`workspaces/<id>/billing/invoices/<number>.pdf`). `/api/billing/invoices`
   answers a presigned `pdfUrl` from that copy, so viewing an invoice never
   opens the issuer's tenant DB.
4. Mirror the invoice into master `billing_invoices`: number, amounts, tax,
   country, `customer_tax_exempt` (`none`, `reverse`, `exempt`), status, due
   date and lines.
5. On payment, record it in WeldBooks (against Mollie as the clearing account)
   and in the mirror.

Refunds are made by staff only: a Mollie refund plus a WeldBooks credit note,
mirrored. If the issuer can't be reached, nothing is charged; the job retries,
and the failure raises an alert (OPS-021). An invoice is never skipped to get
a charge through.

### The webhook

One endpoint, BILL-013's `POST /api/webhooks/mollie`. It reads the payment
back with `GET /payments/{id}` and dispatches on `metadata.kind`:

| `kind` | Purpose | Effect |
|---|---|---|
| `credit_topup` | BILL-013 | Unchanged |
| `billing_first` | `checkout`, `mandate`, `pay_link` | Paid: settle the invoice, store the mandate, activate or apply the change. Failed or expired: nothing (checkout) or keep dunning (pay link). |
| `billing_charge` | `renewal`, `proration`, `retry` | Paid or pending: settle. Failed: dunning. Charged back: reopen and dunning. |

Before applying anything, the handler loads its own payment row by
`paymentRowId` and checks that the payment's `customerId`, amount and
`invoiceId` match it. A mismatch is logged and ignored. Effects are keyed on
the payment id, so a second delivery or the return page settling first
changes nothing. A transient failure (Mollie or the DB unreachable) answers
5xx, and Mollie retries.

### The API: what replaces app-api's and billing-worker's routes

The Rust backend serves app-api's paths under core (`packages/core/api-modules`
already maps `/api/billing` to core), in a new group or crate
(`rust/modules/core-billing`). Permissions are as on Global: `billing:manage`
to spend, `billing:read` to view. Partner workspaces don't exist on the EU
master.

| Route | Rust on EU | Tested by |
|---|---|---|
| `GET /api/billing/plans`, `/plans-page`, `/limits`, `/managed` | Master + the BILL-007 resolver | Conformance (`core: billing` suite) |
| `GET /api/billing/subscription` | `workspaces`, `plans` and the member count, as app-api | Conformance |
| `GET /api/billing/seat-price` | The seat price the running period bills (its plan line). app-api reads it from the Stripe subscription | Rust test |
| `GET /api/billing/invoices`, `/payments` | The master mirrors | Conformance with seeded rows |
| `POST /api/billing/validate-downgrade`, `/enterprise-inquiry` | As app-api | Conformance |
| `GET /api/billing/domains`, `/phone-numbers` | As app-api (lists only) | Conformance |
| `GET /api/billing/phone-subscription` | `{ data: null }`: phone purchases stay hidden | Rust test |
| `POST /api/billing/checkout`, `/seats`, `/cancel`, `/reactivate` | Mollie, as above | Rust tests against a Mollie stub (as `tests/topup.rs`) |
| `GET /api/billing/payment-methods` | The default mandate, in the same shape (`type: card` or `sepa_debit`, brand, last 4) | Rust test |
| `POST /api/billing/payment-methods/setup-intent` | `{ data: { url } }`: a first payment (€0 for a card, €0.01 for iDEAL, refunded) instead of `clientSecret` | Rust test + platform change |
| `POST /api/billing/payment-methods/:id/default`, `DELETE …/:id` | Make the default, or revoke the mandate. Revoking is refused while a paid plan runs on the only mandate | Rust tests |
| `GET /api/billing/checkout/:id` (new) | How a checkout ended | Rust test |
| `GET /public/billing/pay/:token` (new) | Pay link | Rust test |
| `POST /api/webhooks/mollie` | BILL-013's, extended | Rust tests |

What billing-worker does on Global, and what does it on EU:

| billing-worker | EU edition |
|---|---|
| `/api/webhooks/stripe` | `/api/webhooks/mollie` |
| `/api/billing/credits/checkout` | `/api/credits/checkout` (BILL-013) |
| `/api/billing/reach` | In-process: reach calls a `Billing` trait in `core-domain` (phase 5) |
| `/api/billing/phone`, `/sso`, `/app-subscriptions`, `/app-developer-accounts`, `/agents` | Not served (hidden features) |
| `/api/internal/admin/*` (billing) | The EU admin console's screens (SEC-014, FE-018) and `weldsuite admin billing …` |
| Hourly cron: comp sweep, SSO sweep, partner sweeps | `billing-renewals` (renewals, retries, scheduled changes, comps). No SSO or partner sweeps |
| Pricing sync to Stripe | Nothing: prices are master data only |

### Platform changes (behind `billingProvider`)

Global doesn't see any of these:

1. **Payment methods:** with `billingProvider === 'mollie'`, the "Add payment
   method" button redirects to the `url` from `setup-intent` instead of opening
   Stripe Elements. The list shows a SEPA mandate as "Direct debit NL•• … 1234".
2. **Checkout return:** the billing and plans pages read `?checkout=<id>` and
   ask `GET /api/billing/checkout/:id`. This generalises PR #1570's
   `credit-checkout-return.ts`.
3. **Billing details first:** on 400 `BILLING_DETAILS_REQUIRED`, open the
   existing billing-details dialog, then retry the checkout.
4. **Scheduled decreases:** show `effectiveAt` from `/billing/seats`.
5. **Prices excl. VAT**, labelled as such on the plans page.

Every new string goes into en and nl.

### The other Stripe-only features

| Feature | Decision | When |
|---|---|---|
| `credit-top-up` | On Mollie (BILL-013), plus invoices from the same issuer | Phase 5 (the top-up itself is #1570) |
| WeldReach inboxes (REACH-010) | Moves onto Mollie as a per-inbox monthly line, prorated when an inbox is added. Billing-off stays for self-hosted and installs without billing. `rust/modules/reach/src/billing.rs` changes from "always off" to "off without billing" | Phase 5 |
| `domain-purchase`, auto-renew (HOST-004, HOST-005) | Stays hidden. Registration creates a Cloudflare zone; it needs an EU `DnsHost` first. After that: a one-off payment before registering, and renewals on the mandate | When WeldHost has an EU DNS host |
| `phone-number-purchase` (CALL-003) | Stays hidden. Numbers come from Telnyx. After sipgate can order: pay first, then a monthly line | When the EU telephony adapter orders numbers |
| `paid-apps` (APPS-009) | Stays hidden. Needs Mollie Connect, developer payouts and marketplace VAT | No date |
| SSO add-on (BILL-012) | Stays hidden with `sso-connections`. Becomes a monthly line | When SSO runs on Zitadel |
| WeldBooks bank-connection add-on | Stays unbilled, as now | With the add-ons, if wanted |
| Partner billing (BILL-008 to BILL-010) | Not on EU | No date |

### Staff tools

From the EU admin console (FE-018, the workspace page's billing card) and as
`weldsuite admin billing <action> --as <admin> --reason …` (SEC-014), all
audited in `admin_audit_events`:

- `show`
- `comp` / `uncomp` (BILL-011's columns)
- `refund <invoice> [amount]` (Mollie refund plus credit note)
- `retry-now`
- `mark-paid <invoice>` (a bank transfer)
- `set-collection invoice` (later)

## Phases

Each phase lands on its own. Global is untouched throughout.

### Phase 0: decide and set up (no code)

- Gert answers the open questions below.
- The accountant confirms the VAT treatments, the invoice texts, and what
  happens to an unpaid invoice when a plan ends (credit note or bad debt).
- The Mollie account: an EU profile with test and live keys, with recurring
  payments, cards, iDEAL and SEPA Direct Debit enabled (SEPA Direct Debit
  needs Mollie's approval).
- Confirm against Mollie's docs or support:
  - on-demand recurring payments are not retried by Mollie;
  - zero-amount first payments work for cards;
  - iDEAL first payments leave a valid `directdebit` mandate;
  - `payment.mandateId` is set on a paid first payment.
- Decide on OSS registration, or restrict the EU edition to businesses.
- Create the issuer workspace on EU test, with WeldBooks, the legal entity
  WeldSuite B.V. and a numbering series for platform invoices.
- Merge #1570 (BILL-013) first: phase 1 builds on its client and webhook.
- Approve the schema changes, so the migration can be generated in phase 2.

### Phase 1: the Mollie client and the read routes

- Move `topup/mollie.rs` into `rust/crates/mollie` (`weldsuite-mollie`). Keep
  `Money`, `Payment`, `is_payment_id` and the request builders. Add
  customers, mandates (list, get, revoke), customer payments (`first`,
  `recurring`, `mandateId`, `customerId`), refunds and methods
  (`sequenceType=first`). Tests use the recorded-request stub the client
  already has.
- Port the BILL-007 resolver and serve the read routes from master. Add a
  `core: billing` conformance suite against app-api for the routes that read
  only master.
- `billing` stays unavailable until phase 2.

Exit: the client's tests pass and the read routes are at zero differences in
conformance.

### Phase 2: the first checkout and invoices

- The approved migration (`db:generate:master`; SQL, snapshot and journal
  together).
- `InvoiceIssuer` and the WeldBooks adapter: contact upsert, create and
  finalize as the system user, PDF copy, mirror.
- `vat_treatment` with VIES (books-domain), and a test per row of the VAT
  table.
- `POST /api/billing/checkout`, the `billing_first` webhook path, activation
  (plan, seats, status, period, anchor, cap metadata, plan credits) and
  `GET /api/billing/checkout/:id`.
- `BILLING_PROVIDER` and its settings. `edition.rs` drops `billing` when
  configured, and `/config.json` gets `billingProvider`.
- Platform changes 2, 3 and 5.

Exit: P5's "paying (Mollie test mode) works end to end" on EU test. A Free
workspace upgrades to Business with 3 seats and gets an invoice PDF with the
right VAT for a Dutch business, a Belgian business with a VAT number and (if
OSS) a German consumer. The seat gate then allows exactly 3.

### Phase 3: renewals, changes and payment methods

- `weldsuite cron billing-renewals` and its chart job: renewals, scheduled
  changes, comps, monthly plan credits.
- Seat increases and plan upgrades with proration. Scheduled decreases,
  downgrades and cycle changes. Cancel and reactivate.
- Payment methods: a new mandate through a first payment, revoking the old
  one. Platform changes 1 and 4.

Exit: tests driven by an injected clock, over 13 months, with a monthly and a
yearly plan, a mid-period upgrade, a scheduled downgrade and a comp. Duplicate
webhooks and two overlapping job runs charge exactly once.

### Phase 4: dunning and staff tools

- Retries, `past_due`, the end of the subscription, chargebacks.
- Email templates (en/nl) and pay links.
- The admin console's billing card on Kubernetes and the
  `weldsuite admin billing` commands.

Exit: Mollie test-mode failures walk the whole schedule on EU test, and staff
can refund with a credit note. Phases 3 and 4 must be done before the EU
edition's first live charge, since the first renewal follows a month later.

### Phase 5: add-ons onto the monthly charge

- WeldReach inboxes on Mollie: `reach/src/billing.rs` on when billing is
  configured, `GET /api/reach/billing` with a summary, and inbox lines with
  proration. When this lands, REACH-010's status line notes the superseded
  Rust rule.
- Invoices for credit top-ups (BILL-013's follow-up). Optionally, paying a
  top-up with the saved mandate.

Exit: WeldReach setup on EU shows the price, and the inboxes appear on the
monthly invoice.

### Later, when unblocked

- Domains, once WeldHost has an EU DNS host.
- Phone numbers, once sipgate can order them.
- The SSO add-on, once SSO runs on Zitadel.
- Collection by invoice and bank transfer for public-sector customers, with a
  payment term, possibly through Mollie's bank-transfer method, and Peppol
  sending in WeldBooks (Belgian businesses need structured invoices since
  2026).
- Staff price overrides and discounts.

## Timing

Phases 0–2 belong to P5, since its exit criterion needs a paid checkout.
Phases 3–4 must be done before the first EU customer is charged for real.
Phase 5 and later follow demand. The EU edition is dormant until its first
customer (OPS-012), so phases 3 and later can wait for a signed contract,
within the two-week go-live window.

## Risks

- **VAT mistakes** are the costly kind. The accountant's review comes in
  phase 0, and every treatment gets a test.
- **The issuer workspace is a single point of failure for charging.** That is
  deliberate (fail closed), and alerts cover it.
- **Double charges.** Payment rows are created before Mollie is called and
  keyed on the invoice; Mollie's idempotency key is the row id; the job claims
  with `SKIP LOCKED`.
- **SEPA's late failures** reopen paid invoices for up to 8 weeks.
- **The work is larger than BILL-013's top-up by an order of magnitude**,
  because it rebuilds the parts of Stripe Billing WeldSuite uses.

## Open questions for Gert

1. **Who issues the invoices?** BILL-014 proposes WeldBooks in a WeldSuite
   workspace on the EU edition. That gives the BV a second administration.
   Where are the BV's books kept today, and is that acceptable? The
   alternatives are Mollie's Sales Invoices API, or our own renderer.
2. **Consumers, or businesses only?** Selling to EU consumers needs OSS
   registration. Recommendation: businesses only at first (a VAT number or a
   KvK-like number required), which leaves NL 21%, reverse charge, and
   outside-EU.
3. **EUR only**, including for Poland, Sweden, Denmark and other non-euro EU
   countries?
4. **Yearly plans at launch**, or monthly only first?
5. **Proration:** charge seat increases at once, as Global does (proposed), or
   add them to the next invoice?
6. **Seat decreases at the period end, with no credit** (proposed). Global
   credits at once.
7. **The dunning schedule** (3, 7 and 14 days, then Free). Should `past_due`
   lock anything earlier?
8. **Collection by invoice and bank transfer:** do the first EU customers
   (government, healthcare) need it at launch? Which payment term?
9. **Payment methods:** card and iDEAL (SEPA mandate) only, or also Bancontact
   for Belgium, and direct SEPA mandates by IBAN? The latter needs Mollie's
   approval.
10. **An unpaid invoice when the plan ends:** credit note, or open until
    written off? (Also for the accountant.)
11. **Invoice language and numbering:** the workspace's locale (en/nl), and a
    separate number series for platform invoices?
12. **Staff prices and discounts** (Global uses Stripe coupons): needed at
    launch?
