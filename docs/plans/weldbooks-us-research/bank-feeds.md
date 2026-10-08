# Bank-feed aggregators for WeldBooks (`@weldsuite/bank-feeds`)

Research date: 2026-10-07. Method: official docs first (docs.stripe.com, plaid.com/docs, provider docs), then third-party sources, which are marked as such. "UNVERIFIED" means I could not confirm it from a primary source for 2026.

## TL;DR

- **Stripe Financial Connections (FC) is a reasonable first adapter, but it is not the better product. Its advantage is time-to-market.** It fits with what we already run (the Stripe account, a `cus_` per workspace that becomes `account_holder`, the raw-fetch client in `packages/core/stripe`, the HMAC webhook check in billing-worker), has published per-unit prices, and needs no new vendor contract. Plaid is ahead on what an accounting feed needs: up to 24 months of history against FC's 180 days, 1-4 automatic checks a day against FC's once daily, enrichment (merchant, category, check number), documented business-account coverage, and wide use by SMB accounting peers (Xero US, Wave, Odoo US).
- **Two things must be checked before committing to FC.** (1) Eligibility: Stripe's own pages contradict each other on whether a non-US Stripe account (WeldSuite's looks EU-based, since the repo enables iDEAL, Bancontact and SEPA) can use FC data products. (2) Coverage: credit-card linking at Amex, Chase, Capital One and Citi, which no Stripe page lists. Start the FC registration (Dashboard → Settings → Financial Connections) and the Plaid production application on the same day. Both cost nothing to start.
- **Recommended order:** FC first, if both checks pass within about 2 weeks, otherwise Plaid first. The other one goes second, for US fallback and coverage. Teller is a cheap third US option (mTLS works on Workers). First EU provider: **Ponto (Isabel)** for the existing Dutch and Belgian customers, or **Enable Banking** for wider EU and faster self-serve. GoCardless Bank Account Data is closed to new signups.
- **Design the interface around Plaid's model** (connection = Item, cursor sync with added/modified/removed, pending→posted links). FC, Teller and the PSD2 providers all map into that model more easily than Plaid maps into FC's.

---

## Part A — Stripe Financial Connections vs Plaid

### A1. Access and approval

**Stripe FC**
- FC is not on by default. The docs say: "Register for Financial Connections after we approve your account for live-mode access," and "You must have a completed Financial Connections registration to access transactions in live mode" (registration lives at dashboard.stripe.com/settings/financial-connections). Test data is always available. Stripe publishes no review criteria or timeline. A third-party integrator reports that FC can look "enabled" in the Dashboard while live calls still fail until registration completes (UNVERIFIED).
- Gating per permission: the docs only say that `transactions` needs completed registration in live mode. `balances` and `ownership` have no separate gate in the docs. Full account numbers (as opposed to tokenized ones) are limited to businesses "who meet risk and eligibility criteria". We don't need them.
- **Data-only use is supported.** The Sessions API ("build data-powered products") needs no PaymentIntent or ACH. Sessions are meant for accounts you "won't use … for ACH payments" and can link account types that aren't ACH-eligible. Examples Stripe gives: "track expenses, handle bills, manage their finances". Bookkeeping is not named, but it fits.
- **`account_holder`:** `type=customer` (a `cus_`, or a customer-configured v2 Account) or `type=account` (a Connect account). For us the right choice is `type=customer` with the existing workspace `cus_`: WeldSuite is the data recipient, and the workspace owner consents in Stripe's pane. Using Connect would make each workspace a connected account, which adds KYC overhead for nothing. The Connect payouts guide also says only "Stripe platforms in the US" can request extra data from connected accounts.
- **Country eligibility conflicts across Stripe's own pages:** the FC overview lists businesses in ~35 countries incl. NL/GB "for use with US bank accounts"; the data-products guide is tagged "Available in: US"; the support FAQ says "generally available for businesses in the United States only. International businesses … can contact sales." **Confirm which entity owns WeldSuite's Stripe account and ask Stripe to confirm FC data access (transactions) for it.** If it requires a US Stripe account, the "existing account" advantage largely disappears.
- Terms: the Stripe Financial Connections Data Services Terms limit use to the "Authorized Purpose" shown in the consent (§3.1), ban selling data (§3.1), allow Stripe to suspend us if we change the purpose (§8.2), allow a yearly compliance attestation (§4.7), and end when the Stripe agreement ends (§8.1). Nothing in them requires using Stripe payments.

**Plaid**
- Plans: **Trial** (free, 10 Items, US/CA developers only, no security questionnaire), **Pay-as-you-go** (no minimum), **Growth** (12-month commitment, minimum spend), **Custom/Scale** (higher minimum). A Plaid support article (seen only as a search snippet; it returns 403 to direct fetch) says **"for customers based in Europe, we only offer Custom plans"**, and that Limited Production is restricted to US/CA developers for signups after 2026-04-15 (UNVERIFIED). If WeldSuite contracts as a Dutch entity, expect a sales-led Custom deal with minimums.
- Production steps (Dashboard compliance center): app display profile, company info, MSA, **security questionnaire** (required before Chase and PNC on paid plans), and an optional LEI. Most OAuth institutions turn on "within hours" after registration, Schwab within up to 5 business days, and Fidelity/Schwab "may take longer". Bank of America Items are being moved to OAuth throughout 2026 through update mode. Secondhand reports from July 2025 put Chase OAuth approval at 3-4 months for some apps (UNVERIFIED for 2026).
- Common causes of delay or rejection for small SaaS (third-party and community sources, UNVERIFIED): an incomplete application profile (some banks block empty profiles), questionnaire answers that don't match real controls (MFA, encryption, a policy set; a SOC 2 report helps), slow answers to compliance requests (one reading of the terms says suspension after 3 business days), and unclear data-use statements.

### A2. Pricing (2026)

| | Stripe FC | Plaid |
|---|---|---|
| Transactions | **€0.30 per institution per account holder per month** on stripe.com/financial-connections. The page was served in EUR to our NL IP. stripe.com/pricing showed €0.25, which conflicts. Historically $0.30 in the US (third-party). | Subscription per **Item** (one institution login) per month while an `access_token` exists, even with no calls. Calendar months in UTC, not prorated. Rate not published. Community reports ~$0.30/Item/month PAYG; one report of $0.25 plus a $500/month minimum on Scale (UNVERIFIED) |
| Balances | €0.10 per successful refresh call | Per request (Balance), or included as cached balances in Transactions responses |
| Ownership | €1.50 per call | Identity, one-time fee |
| Link/verification | "Instant bank account verification €1.50 per verified account". A third party says data-only linking costs $1.50/account (UNVERIFIED whether it applies without `payment_method`) | None for Transactions. Auth and Identity are one-time per Item |
| On-demand refresh | `refresh` API, no separate price listed | `/transactions/refresh` per request |
| Free/test | Test mode (always available) | Sandbox free. Trial 10 Items (US/CA only) |

Per active connection per month the prices are about the same (~$0.30 for an institution). The billing unit differs: FC charges per institution per account holder, so one workspace with Chase checking and a Chase card pays once. Plaid charges per Item, the same in practice. Plaid's risk is orphaned Items, which keep billing until `/item/remove` is called, plus Custom-plan minimums.

### A3. Data, history, refresh

| | Stripe FC `financial_connections.transaction` | Plaid `/transactions/sync` |
|---|---|---|
| Fields | `id` (fctxn_), `account`, `amount` (integer, minor units), `currency`, `description`, `status` pending/posted/void, `status_transitions.posted_at/void_at`, `transacted_at` (unix), `transaction_refresh`, `updated` | `transaction_id`, `account_id`, `amount` (decimal), `iso_currency_code`, `date`, `authorized_date`, `datetime`, `pending`, `pending_transaction_id`, `merchant_name`, `original_description` (opt-in), `personal_finance_category` (primary/detailed/confidence), `counterparties`, `check_number`, `payment_channel` |
| Sign | Docs example shows `-1000` for a purchase, so **negative = outflow** (inferred; the field doc doesn't say; test it on credit cards) | **positive = money out**, negative = money in (documented) |
| History on first link | "up to the last 180 days … depending on the account's financial institution" | `days_requested` default 90, **max 730**. Must be set at Link/init and can't be raised on an existing Item. History grows while the Item stays connected |
| Change feed | `transaction_refresh[after]=<last refresh id>` returns new and updated transactions | Opaque `cursor`. Returns `added`/`modified`/`removed` and `has_more`. Restart the page loop on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` |
| Refresh | `subscribe` gives a **daily** background refresh. `refresh` on demand, limited by `next_refresh_available_at`. `prefetch` at link time | Automatic **1-4×/day** per institution. `/transactions/refresh` costs extra |
| Webhooks | `financial_connections.account.refreshed_transactions` (check `transaction_refresh.status`), `.created`, `.deactivated`, `.reactivated`, `.disconnected`, `.upcoming_deactivation` (30 days), `.expected_deactivation_date_updated`, `.refreshed_balance` | `SYNC_UPDATES_AVAILABLE` (`initial_update_complete`, `historical_update_complete`). Item: `ERROR`/`ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT` (US/CA, 7 days before consent expiry), `NEW_ACCOUNTS_AVAILABLE`, `USER_PERMISSION_REVOKED` |
| Pending→posted | Same object changes `status` and gets `posted_at` (inferred from the schema). Vanished holds become `void` | Pending `transaction_id` goes to `removed`. The posted one is **new** in `added` with `pending_transaction_id`. Name and amount may differ. Usually 1-5 business days, up to 14. **Capital One and USAA provide no pending** |
| IDs | `fctxn_` looks stable across refreshes | `transaction_id` is unique, but posting creates a new ID. Posted transactions are "not necessarily immutable" |

For accounting, FC's 180-day cap means a customer onboarding in October can't backfill to 1 January from the feed; they need CSV/OFX import. FC has no merchant or category fields, so categorisation runs on the raw description (we could use `@weldsuite/ai` for this anyway).

### A4. Coverage

- **FC:** "more than 12,000 supported banks", "more than 97% of US bank accounts", OAuth by default where the bank has it. The account model includes `credit` → `credit_card`, `line_of_credit`, `mortgage`, and `filters.account_subcategories` accepts `credit_card` (added 2024-09-30), so **credit cards are supported in principle**. The per-institution list (docs.stripe.com/financial-connections/supported-institutions) renders client-side, so I could not check Chase, BofA, Wells, Citi, Capital One or Amex, cards or business accounts. **UNVERIFIED.** Business accounts are not mentioned anywhere. Outside the US: the Stripe roadmap lists "Financial Connections in Canada" for Q4 2026. No EU/UK bank data (Stripe's EU product is Pay by Bank, for payments).
- **Plaid:** 12,000+ institutions (US/CA/UK/EU). Transactions covers depository, credit and loan accounts. Business accounts at ~95% of US banks serving SMBs (4,500+ institutions; Plaid blog), with a business/personal indicator (beta). Amex works through OAuth. Pitfall: asking for `auth` in Link hides credit cards. Request only `transactions` (ERPNext community report).

### A5. UX

- **FC:** server creates a Session, client calls `stripe.collectFinancialConnectionsAccounts({clientSecret})` (modal, Stripe.js). A hosted mode exists (`ui_mode=hosted`, API 2025-11-17, where `client_secret` is null). `return_url` is only for webviews. Stripe Link may offer returning users saved accounts. Re-auth: the relink API (public preview), hosted relink by Dashboard or email (public preview), hosted relink API (private preview). Disconnect: `POST /accounts/:id/disconnect`. Afterwards **previously refreshed data is no longer readable**, so we must store everything ourselves.
- **Plaid:** `/link/token/create`, then Link (`react-plaid-link` `usePlaidLink`, or Hosted Link), then `public_token` exchanged for `access_token`. **Update mode**: pass `access_token` in the link token to repair an Item (`ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`) or add accounts (`account_selection_enabled`). Chase account removal has to happen in Chase's Security Center. Disconnect: `/item/remove`, which also ends billing.

### A6. Cloudflare Workers compatibility

- **Stripe:** plain HTTPS and form-encoded. The repo already calls Stripe with raw `fetch` (`packages/core/stripe/src/index.ts`) and verifies `Stripe-Signature` itself (`apps/workers/billing-worker/src/routes/webhooks.ts`). stripe-node also runs on Workers (`Stripe.createFetchHttpClient()`, `webhooks.constructEventAsync` with `createSubtleCryptoProvider()`). Use a **separate webhook endpoint and secret** for FC events in books-api, not billing-worker.
- **Plaid:** JSON POST with client_id and secret. `plaid` npm 48.0.0 has a single dependency, `axios ^1.7.4`. Axios 1.7+ has a fetch adapter, so `new Configuration({ baseOptions: { adapter: 'fetch' } })` should work (untested). The safer route is raw `fetch` using Plaid's OpenAPI types. Webhook check: decode the JWT in `Plaid-Verification`, require `alg=ES256`, fetch the JWK by `kid` from `/webhook_verification_key/get` (cache it in KV), verify with `crypto.subtle` ECDSA P-256, require `iat` ≤ 5 min old, and compare the SHA-256 of the raw body against `request_body_sha256` in constant time.

### A7. Compliance obligations for WeldSuite

Both providers:
- Privacy policy and consent copy name the provider and say what the data is used for (bookkeeping only, no selling, no use for model training unless disclosed).
- Request the minimum: `transactions` and `balances`. Not `ownership`, not account numbers.
- A written retention schedule (accounting records are usually kept 7 years, so say so). A delete flow for disconnect and for workspace deletion. An information-security programme matching what we tell the providers.
- **GLBA:** Stripe states it is not a GLBA "Financial Institution" (§5.3). For WeldSuite, business accounts aren't consumer data, but sole proprietors often link personal accounts. Treat the data as GLBA/FTC Safeguards-grade (encryption, MFA, access logs, incident response) and get legal confirmation. CCPA/GDPR rights requests apply as well.

FC-specific (Data Services Terms plus the Merchant Guidelines):
- Keep consent records, including screenshots of our screens and the dates they were live.
- Tell Stripe within 5 business days of an end-user rights request.
- Send deletion requests to privacy@stripe.com or Stripe's disconnection form, and also delete on our side "or notify the end user of your legal basis for retaining".
- Pass complaints to complaints@stripe.com, executive or regulator complaints within 1 day.
- No FCRA consumer-report use.
- Tell users that "disconnection will stop the sharing of new financial account data" but doesn't delete it.

Plaid-specific:
- Follow the MSA and Developer Policy (no selling or renting end-user data; Plaid may suspend after a failed compliance review).
- Call `/item/remove` when a user disconnects or a workspace is deleted.
- Expect a security questionnaire and periodic attestations.
- Plaid's End User Privacy Policy appears in Link. Our policy must not contradict it.

### A8. Verdict and concrete risks

**FC first if:** (a) Stripe confirms live `transactions` access for WeldSuite's Stripe entity, (b) a live spike links a credit card at Amex, Chase, Capital One and Citi plus a business checking account and returns transactions, and (c) 180 days of history is acceptable with CSV import as the backfill. Otherwise Plaid first.

FC risks:
1. Eligibility of a non-US Stripe account.
2. The 180-day history cap.
3. Credit-card and business-account coverage is undocumented.
4. Only one refresh a day, and the data is thin (no merchant, category or check number).
5. **Account-risk concentration:** the same Stripe account bills every WeldSuite subscription. A restriction, a dispute-ratio problem, or termination under §8.1/§8.2 would stop billing and every customer's bank feed together. Consider a separate Stripe account or entity for FC.
6. Relink is still in preview.
7. Unclear whether the €1.50 "verified account" fee applies to data-only links.
8. Stripe Link prompts in a B2B flow.

Plaid risks:
1. Approval and Custom-plan-only terms for a Europe-based contracting entity. Unpublished prices and possible minimums.
2. Security questionnaire, and slow OAuth enablement at some big banks.
3. Billing on orphaned Items.
4. JPMorgan's data-access fees (deals with Plaid in Sep 2025 and Yodlee in Nov 2025). Plaid reportedly absorbs them for now (UNVERIFIED), and they could be passed through later.
5. The axios-based SDK. Use raw fetch.

---

## Part B — Other providers

| Provider | Approval difficulty | Pricing model | US coverage (incl. cards) | Sync style | Webhooks | Workers-compatible | Sandbox |
|---|---|---|---|---|---|---|---|
| **Stripe FC** | Low-medium: FC registration on top of a live account. Non-US entity unclear | Published: €/$0.30 per institution per holder per month for transactions, plus per-call balances and ownership | 12k FIs, 97% of accounts. Card subcategory exists, issuer list unverified. US accounts only (CA Q4 2026) | Refresh-id cursor, daily | Yes (Stripe-Signature HMAC) | Yes, already in repo | Test mode |
| **Plaid** | Medium-high: application, security questionnaire, Custom-only for EU-based customers | Per Item per month (subscription). Rates unpublished (~$0.30) | 12k+ FIs. Cards incl. Amex. Business accounts ~95% of SMB banks | Cursor (`/transactions/sync`) | Yes (ES256 JWT) | Yes (raw fetch) | Free sandbox. Trial 10 Items (US/CA) |
| **Teller** | Low-medium: self-serve, billing setup for production | Usage-based, unpublished. 100 free development enrollments (Rutter guide) | US only. Institution count UNVERIFIED | Date range / `from_id` paging, no change feed. Re-pull 7-10 days (dates move on posting) | `enrollment.disconnected`, `transactions.processed` (HMAC-SHA256, 3-min window) | Yes via **mTLS binding**. `api.teller.io` is an AWS ELB, not a proxied CF zone, so `[[mtls_certificates]]` + `env.CERT.fetch()` applies | Sandbox needs no cert |
| **MX** | High: sales-led, enterprise | Contract. Third-party says free dev up to 100 users (UNVERIFIED) | 10-16k FIs (sources disagree). Cards yes | Aggregate member, then pull by date (detail UNVERIFIED) | Yes (dashboard-configured) | Yes (REST, basic auth) | Yes |
| **Finicity (Mastercard Open Finance)** | High: sales-led | Contract, per-event tiers (third-party) | Broad US, strong FDX/OAuth deals. Cards yes | Date range after refresh, plus TxPush (detail UNVERIFIED) | Yes | Yes (REST) | Yes |
| **Yodlee** | High: sales-led | Contract | ~19k data sources globally. Cards yes | Date range, refresh notifications (detail UNVERIFIED) | Yes | Yes (REST) | Yes |
| | *Ownership: Envestnet sold Yodlee to private-equity firm **STG**; closed 2 Sep 2025. Now a standalone company.* | | | | | | |
| **Akoya** | High: questionnaire, pricing, security review, legal. Network of FDX bank APIs | Standard (<10k connections/month) vs Enterprise, unpublished. Possible setup fee | OAuth-only, 4,300+ FIs claimed (third parties count far fewer). Long tail missing | FDX date range (`startTime`/`endTime`) | Limited (UNVERIFIED) | Yes (OAuth2/REST) | Free self-serve |
| **Quiltt** | Medium: one contract over MX/Finicity/Akoya (and Plaid with your own keys) | Platform fee + per connection, unpublished | Union of the underlying aggregators | GraphQL, normalised | Yes | Yes (GraphQL/HTTPS) | Yes |
| **GoCardless Bank Account Data** | **Closed:** "New signups for Bank Account Data are currently disabled" (since ~July 2025) | n/a | EU/UK | Date range, 90-day consents | No | Yes | n/a |
| **Enable Banking** (FI-licensed AISP) | Low-medium: self-serve sandbox and free restricted mode. Contract + KYB before going public | Volume per account accessed, monthly minimum, quote | EU/EEA/Nordics + UK (2,500+ ASPSPs, UNVERIFIED) | Date range + `continuation_key` (`strategy=longest`) | Not for AIS (UNVERIFIED), poll | Yes: RS256 JWT signed with app key via WebCrypto | Mock ASPSPs |
| **Ponto (Isabel)** (BE-licensed AISP) | Medium: partner agreement | Per linked account per month. **Partner-paying or customer-paying** (end customer pays Ponto). Old list ~€4/account | 1,800+ banks in 15 countries. Strong NL/BE (ING, ABN AMRO, Rabobank, KBC…). No savings accounts | Synchronization jobs + pull | Yes (new transactions) | Likely needs **mTLS**: `api.ibanity.com` aborted our TLS handshake without a client cert. Workers mTLS binding should work (not a CF zone). UNVERIFIED | Free sandbox |
| **Salt Edge** | Medium: Partner Program, pending partners limited to sandbox until approved | Usage-based quote. 100 free live connections (limited-time) | 5,000+ banks, ~44 countries | Connections + date/`from_id` paging, daily auto-refresh | Callbacks | Yes (RSA request signing via WebCrypto; UNVERIFIED) | Yes |
| **Tink (Visa)** | High: sales-led | Custom, minimums possible | EU/UK, 3.4-6k FIs (sources disagree) | Date range / page token | Yes | Yes | Yes |
| **Yapily** | Medium | Quote, "self-serve" listed | ~2,000 banks, 19 countries incl. NL. LT-licensed | Date range | Limited | Yes | Yes |
| **TrueLayer** | Medium-high: data reportedly sold mainly with payments (competitor claim) | Startup/Scale, custom | UK + EU | Date range, async results | Yes (JWS-signed, UNVERIFIED) | Yes | Yes |

What matters for the design:
- Only Plaid (and Quiltt) give a true server-side change cursor. FC gives a refresh-id watermark. Everyone else is **date-range polling**, so the neutral interface needs a re-pull window and fingerprint dedupe.
- PSD2 limits unattended pulls to 4 a day per account, and consent must be renewed every 180 days (90 at some banks).

---

## Part C — Context

### C1. CFPB §1033 (personal financial data rights), status October 2026

- The final rule was issued 22 Oct 2024 and took effect 17 Jan 2025. The CFPB later said the rule should be set aside and issued an ANPR in Aug 2025 (asking about fees, security, privacy, and who counts as a "representative").
- On **29 Oct 2025 the E.D. Ky. (Forcht Bank v. CFPB, 5:24-cv-304) stayed the compliance dates and enjoined enforcement until reconsideration is finished**, so the 1 Apr/30 Jun 2026 first-tier date has no force.
- The CFPB dropped the interim-final-rule plan for full rulemaking (Jan 2026) and **sent a proposed rule to OIRA on 6 Aug 2026**. As of early Oct 2026 it has not been published. Reports say it allows banks to charge **data-access fees** and narrows "authorized representative" (UNVERIFIED until publication).
- **FDX** was recognised as a standard-setting body on 8 Jan 2025.
- **Scope:** Reg E accounts and Reg Z credit cards held by **consumers** (natural persons). Business accounts appear to be out of scope (an inference from the definitions, not stated outright).
- **What this means for aggregator choice:**
  - Nothing forces banks onto APIs on a fixed timetable. Coverage still depends on each aggregator's bilateral deals: JPMorgan now charges Plaid, Yodlee, Morningstar and Akoya.
  - Business-account access will never be guaranteed by 1033.
  - Expect per-pull bank fees to show up in aggregator prices over time.
  - Avoid scraping-only providers for big banks; OAuth/FDX coverage (Plaid, Finicity, Akoya, MX, Stripe) is the safer bet.
  - Plaid already flags that an LEI will be required "under the section 1033 rule".

### C2. What SMB accounting tools use for US feeds

- **Xero US:** Plaid partnership (July 2025), rolled out from late 2025 and moving existing feeds to Plaid. Also direct bank feeds. Xero's May 2026 House testimony (seen only via a search summary) cites 1,500+ US institutions reached through data networks.
- **Wave:** Plaid (US/CA). Automatic import is in the Pro plan.
- **FreshBooks:** Yodlee for the US, Plaid for CA/UK/EU (per its country chart, which is hard to read; verify). Up to 2 years of history. Salt Edge mentioned by third parties only.
- **Odoo:** Plaid (US/CA), Yodlee and Salt Edge (worldwide), **Ponto** (Europe), Enable Banking (Nordics). Enterprise plan only.
- **QuickBooks:** Intuit's own aggregation, plus direct token-based deals with banks (e.g. Chase) and aggregators for the long tail. Not publicly documented (UNVERIFIED).

The pattern: **nobody relies on one provider**. Plaid is the most common US choice for SMB tools. Ponto is common in NL/BE accounting (also Yuki, Kees de Boekhouder).

### C3. Normalised model for `@weldsuite/bank-feeds`

**Adapter interface** (each provider declares `capabilities`: `changeCursor`, `webhooks`, `pendingTransactions`, `maxHistoryDays`, `onDemandRefresh`, `accountTypes`, `regions`, `consentTtlDays`):
- `createLinkSession({ workspaceId, mode: 'create'|'reauth'|'add_accounts', connectionId?, accountTypes, historyDays, redirectUrl })` returns `{ kind: 'plaid_link'|'stripe_fc'|'redirect', token|clientSecret|url }`
- `completeLink(payload)` returns `{ connection, accounts[] }`
- `syncTransactions(connection, cursor)` returns `{ upserts[], removals[], nextCursor, hasMore }`
- `getBalances(connection)`, `refresh?(connection)`, `disconnect(connection)`, `parseWebhook(request)` returning `NormalizedEvent[]`

**Entities** (tenant DB, every row scoped by `workspaceId`; secrets envelope-encrypted, never in clear):
- **connection:** `id`, `provider`, `providerConnectionId`, `institution{id,name}`, `status` (`active|reauth_required|expiring|revoked|disconnected|error`), `consentExpiresAt`, `cursor` (opaque JSON per provider), `lastSyncedAt`, `credentialsRef`, `region`.
  - Plaid Item = connection. FC has no Item: group FC accounts by session/institution, but keep status per account, because FC deactivates and relinks per account.
- **account:** `id`, `connectionId`, `providerAccountId`, `type` (`depository|credit|loan|other`), `subtype` (`checking|savings|credit_card|line_of_credit|mortgage|other`), `name`, `mask`, `currency`, `isBusiness?`, `ledgerAccountId`, `syncFromDate`, `fingerprint` (institution + mask + subtype; Plaid `persistent_account_id` when present). The fingerprint lets a relink or a provider switch reattach to the same ledger account.
- **transaction:**
  - Identity and amount: `id`, `accountId`, `provider`, `providerTxnId`, `providerPendingTxnId`, `status` (`pending|posted|void`), `amountMinor` (bigint), `currency`.
  - Dates: `bookedDate`, `transactedDate`, `valueDate?`.
  - Text and enrichment: `description` (raw), `merchantName?`, `counterpartyName?`, `counterpartyIban?`, `remittanceInfo?` (key for EU invoice matching), `checkNumber?`, `providerCategory?`.
  - Bookkeeping: `raw` (jsonb), `fingerprint`, `firstSeenAt`, `updatedAt`, `removedAt?`.
  - **Sign convention:** account-holder perspective, money in positive, money out negative, like a bank statement. A card purchase is negative (it raises the liability). Plaid amounts must be negated. FC and most PSD2 APIs already match (Berlin Group uses `creditDebitIndicator` or a signed amount). Store integers, never floats (Plaid and Teller send decimals or strings).
  - **Dedupe:** primary key `unique(accountId, provider, providerTxnId)`. A secondary `fingerprint = hash(account.fingerprint, bookedDate, amountMinor, normalised description, nth occurrence)` is used only to flag likely duplicates after a relink or a provider switch, and for EU banks with no stable `entryReference`.
  - **Pending→posted:** pending rows show in the feed but never become reconcilable statement lines.
    - Plaid: when the posted row's `pending_transaction_id` matches, carry the user's categorisation over and mark the pending row `void`.
    - FC: update in place.
    - Teller and PSD2: match pending to booked by amount ±, date within 10 days and description similarity, then void unmatched pending rows after 14 days.
- **balance:** `accountId`, `current`, `available?`, `creditLimit?`, `asOf`. One snapshot per sync, kept for statement reconciliation.
- **Normalised events** (go to the entity-event bus/realtime):
  - `connection.status_changed` (reauth_required, expiring with date, revoked, disconnected)
  - `transactions.available` (triggers a sync job)
  - `accounts.new_available`
  - `balance.updated`
  - Mapping: Plaid `ITEM_LOGIN_REQUIRED`/`PENDING_DISCONNECT`/`USER_PERMISSION_REVOKED`/`SYNC_UPDATES_AVAILABLE`/`NEW_ACCOUNTS_AVAILABLE`; FC `deactivated`/`upcoming_deactivation`/`disconnected`/`refreshed_transactions`; Teller `enrollment.disconnected`/`transactions.processed`; PSD2 consent `valid_until`.

**Quirks the layer must absorb (Plaid vs FC first):**
1. Opposite signs, and float vs integer amounts.
2. Plaid creates a new ID on posting; FC changes status in place.
3. Plaid history is fixed when the Item is created, so ask for 730 days up front. FC is capped at 180.
4. Plaid syncs 1-4×/day plus a paid refresh. FC syncs daily plus refresh gated by `next_refresh_available_at`.
5. FC data is gone after disconnect, so persist everything. Plaid keeps billing until `/item/remove`.
6. Plaid connections are per Item; FC status is per account.
7. Capital One and USAA have no pending through Plaid. In Plaid, `auth` hides credit cards.
8. FC `transacted_at` is a unix timestamp (date-only data may come as midnight UTC), while Plaid sends local `YYYY-MM-DD`. Normalise to a calendar date without converting time zones.
9. Webhooks are verified three ways: HMAC (Stripe, Teller), ES256 JWT with key fetch (Plaid), mTLS or JWT on outbound calls (Teller, Ponto, Enable Banking).
10. Run syncs as idempotent queue jobs per connection, deduped by connection id, because webhooks arrive at-least-once and out of order.

### C4. Recommendation

1. **Start in parallel this week:**
   - Stripe FC registration, and a written question to Stripe about eligibility for WeldSuite's Stripe entity and whether the "verified account" fee applies.
   - The Plaid production application, plus a Custom-plan quote if we contract from the NL entity.
   - Spike each provider's sandbox through the same `@weldsuite/bank-feeds` interface.
2. **First provider:** FC, if eligibility and the live card/business-account checks pass, because it adds the least vendor and ops overhead. Otherwise **Plaid**. If both are available, Plaid has the stronger product (24-month backfill, more frequent refresh, richer data, peer adoption), and it is the default for any customer whose bank FC can't link.
3. **Second US provider / fallback:** whichever of FC or Plaid isn't first. **Teller** is third for cheap direct coverage of the big banks (workable on Workers with an mTLS binding). Leave MX, Finicity and Yodlee for later (sales-led), or reach them through **Quiltt** if coverage gaps show up.
4. **First EU provider:** **Ponto** for the existing NL/BE customers. It is the Benelux accounting standard (Yuki, Kees de Boekhouder, Odoo), has accountant mandates, and offers customer-paying pricing so WeldSuite carries no cost. Add **Enable Banking** for the rest of the EU and the Nordics (self-serve, licensed AISP, JWT auth on Workers). Don't plan on GoCardless BAD. For the UK, look at TrueLayer, Yapily, or Plaid UK when needed.
5. **Guardrails:**
   - Keep CSV/OFX/CAMT.053 import as the universal fallback and for backfill beyond 180 days.
   - Store provider tokens with envelope encryption.
   - A per-workspace provider choice, with automatic fallback when an institution can't be linked.
   - A disconnect/delete flow that calls each provider's revoke endpoint.
   - A cost dashboard counting active connections per provider.

---

## Unverified items and open questions

- Whether FC data products (transactions) are allowed for a non-US Stripe account. Which legal entity owns WeldSuite's Stripe account.
- FC per-issuer coverage for credit cards (Amex, Chase, Citi, Capital One) and business accounts. FC USD prices for 2026. Whether the "verified account" fee applies to data-only sessions. FC sign convention on credit-card accounts.
- Plaid 2026 unit prices and minimums. "Europe-based = Custom only" and the Limited Production change on 2026-04-15 (seen only in search snippets). Current Chase OAuth enablement time.
- Teller, Ponto and Enable Banking prices. Ponto's mTLS and request-signing requirements. Whether Enable Banking has AIS webhooks.
- The content of the 1033 reconsideration proposal (at OIRA, not yet published).

## Sources

Stripe:
- https://docs.stripe.com/financial-connections
- https://docs.stripe.com/financial-connections/fundamentals
- https://docs.stripe.com/financial-connections/transactions
- https://docs.stripe.com/financial-connections/other-data-powered-products.md?platform=web
- https://docs.stripe.com/financial-connections/use-cases
- https://docs.stripe.com/financial-connections/webhooks
- https://docs.stripe.com/financial-connections/relink
- https://docs.stripe.com/financial-connections/disconnections
- https://docs.stripe.com/api/financial_connections/sessions/create
- https://docs.stripe.com/api/financial_connections/accounts/object
- https://docs.stripe.com/api/financial_connections/transactions/object
- https://docs.stripe.com/changelog/dahlia/2026-07-29/financial-connections-advanced-session-config
- https://docs.stripe.com/changelog/clover/2025-11-17/financial-connections-client-secret
- https://stripe.com/financial-connections
- https://stripe.com/pricing
- https://stripe.com/roadmap.md
- https://stripe.com/legal/financialconnections
- https://support.stripe.com/questions/financial-connections-merchant-guidelines
- https://support.stripe.com/questions/where-is-financial-connections-currently-available

Plaid:
- https://plaid.com/pricing/
- https://plaid.com/docs/account/billing/
- https://plaid.com/docs/link/oauth/
- https://plaid.com/docs/link/update-mode/
- https://plaid.com/docs/transactions/
- https://plaid.com/docs/transactions/transactions-data/
- https://plaid.com/docs/api/products/transactions/
- https://plaid.com/docs/api/webhooks/webhook-verification/
- https://plaid.com/blog/transactions-for-business/
- https://registry.npmjs.org/plaid/latest
- https://discuss.frappe.io/t/whats-needed-to-get-credit-card-accounts-working-with-plaid/115201
- https://community.emma-app.com/t/plaid-is-expensive-how-do-you-survive/2051

Other US providers and Cloudflare:
- https://teller.io/docs/api/authentication
- https://teller.io/docs/api/account/transactions
- https://teller.io/docs/api/webhooks
- https://docs.rutter.com/platforms/banking/teller
- https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
- https://www.envestnet.com/newsroom/press-releases/envestnet-inc-completes-sale-yodlee-inc-stg
- https://docs.mx.com/resources/webhooks
- https://docs.akoya.com/docs/guide-for-production-access
- https://akoya.com/fintechs
- https://www.quiltt.io/account-aggregation

EU providers:
- https://bankaccountdata.gocardless.com/new-signups-disabled
- https://actualbudget.org/docs/advanced/bank-sync/gocardless/
- https://enablebanking.com/docs/faq
- https://enablebanking.com/docs/api/quick-start
- https://www.isabel.eu/en/products/ponto
- https://myponto.com/en/pricing/partner-paying-model/
- https://support.yuki.nl/en/support/solutions/articles/80001132621
- https://saltedge.com/products/spectre
- https://docs.saltedge.com/partners/v1/

§1033 and JPMorgan fees:
- https://www.consumerfinance.gov/compliance/compliance-resources/other-applicable-requirements/personal-financial-data-rights/
- https://www.consumerfinancemonitor.com/2026/08/06/cfpb-sends-new-section-1033-open-banking-proposal-to-oira-for-review/
- https://www.cozen.com/news-resources/publications/2026/section-1033-compliance-date-open-banking-rule-enjoined-and-under-reconsideration
- https://bankingjournal.aba.com/2025/11/kentucky-federal-court-enjoins-cfpb-from-enforcing-current-1033-final-rule/
- https://www.americascreditunions.org/news-media/news/credit-union-win-cfpb-start-new-rulemaking-process-personal-financial-data-rights
- https://financialdataexchange.org/fdx-feed/fdx-recognized-by-cfpb-as-a-standard-setting-body-a-step-forward-for-open-banking/
- https://www.emarketer.com/content/jpmorgan-open-banking-fees-plaid-yodlee-morningstar

What SMB accounting tools use:
- https://www.xero.com/us/media-releases/xero-plaid-partnership/
- https://support.waveapps.com/hc/en-us/articles/115005541303
- https://support.freshbooks.com/hc/en-us/articles/232009268
- https://www.odoo.com/documentation/master/applications/finance/accounting/bank/bank_synchronization.html
