# Stripe connector and Moneybird push

Status: built, not yet live (2026-10-24). Owner decisions below are settled; do not re-ask.
ADRs: INT-010 (Stripe auth and events), INT-011 (Moneybird push) in `weldsuite-documentation`.

Before production: run the push against a Moneybird **test administration**.
The Moneybird write calls follow its API docs (`link_booking` sign rule,
payments with `financial_mutation_id`, statement mutation ids in the create
response) and are covered by mocked tests only.

## Goal

A workspace connects its Stripe account in Integrations. Paid Stripe invoices land
in WeldBooks as sales invoices, and Stripe's money movements (payments, fees,
payouts) land on a "Stripe balance" bank account. WeldBooks then sends all of it
on to Moneybird, so the bookkeeping there is done without manual entry.

```
Stripe ──(Connect OAuth / restricted key)──▶ WeldBooks ──(Moneybird OAuth)──▶ Moneybird
  invoices                                        sales invoices                  external sales invoices (+PDF)
  payouts + balance transactions                  "Stripe balance" bank lines     "Stripe" financial account statement,
                                                                                  lines linked: payment → invoice,
                                                                                  fees → fee ledger, payout → transfer ledger
```

## Decisions (owner, 2026-10-24)

| Topic | Decision |
|---|---|
| Scope | Product feature: a `stripe` connector in the catalog; Moneybird push is a setting on the existing Moneybird connection. Settings live on the connection. |
| What is imported | Stripe invoices (subscriptions / Stripe Billing). No Checkout-only payments. |
| Grouping | One WeldBooks sales invoice per Stripe invoice. |
| Moneybird document | External sales invoice (`external_sales_invoices`), Stripe's number as reference, PDF attached. |
| Timing | Automatic, after every Stripe import. Failures show on the Moneybird connection with a retry. |
| Extras | Payments (mark paid), Stripe fees as costs, payouts to the bank. Refunds are not mapped (their statement lines stay unlinked in Moneybird). |
| VAT | Stripe Tax. Copy VAT per line; match the Moneybird sales tax rate by percentage, with overrides for reverse charge / outside EU / exempt / no tax. |
| History | A start date picked on connect (`importStartDate`). |
| Stripe auth | Stripe Connect OAuth (Standard) on WeldSuite's Stripe platform (the billing account), scope `read_write`: Stripe only lets platforms ask for `read_write` (read-only is reserved for Stripe Apps; the old read-only "extensions" are retired). We only read. API calls use the platform key + `Stripe-Account` (the OAuth `access_token` is deprecated). Fallback "Advanced: connect with an API key" (restricted key), needed for WeldSuite's own sales (a platform cannot connect to itself) and for accounts controlled by another platform. A read-only Stripe App is a possible later step. |
| Money flow in Moneybird | "Stripe as an account": the user adds a Stripe financial account in Moneybird once; per payout we post one financial statement there and link each line. |
| Schema | One tenant migration: nullable `settings` jsonb on `connector_connections`. |

## Data flow

### Stripe → WeldBooks (connector `stripe`)

Catalog syncs:

| syncName | Stripe source | WeldBooks entity | externalEntityType | settingKey |
|---|---|---|---|---|
| `stripe-invoices` | `/v1/invoices` (finalized, `created >= importStartDate`), incremental via `/v1/events` | invoice (+ party from the invoice's customer snapshot) | `stripe_invoice` (party: `stripe_customer`) | `invoices` |
| `stripe-balances` | one row per currency of `/v1/balance` | bank_account "Stripe balance (EUR)" | `stripe_balance` | `bankAccounts` |
| `stripe-balance-transactions` | paid payouts (`/v1/payouts?status=paid`) and their balance transactions (`/v1/balance_transactions?payout=…`, `expand[]=data.source`) | bank_transaction | `stripe_balance_transaction` | `bankTransactions` |

- API version pinned with `Stripe-Version: 2024-06-20` (charge.invoice still present).
- Balance transactions are expanded: the gross line (`txn_…`) and, when `fee ≠ 0`,
  a fee line (`txn_…_fee`). Every line carries `payout_id`. The payout itself is a
  negative line. A charge line whose charge belongs to an imported Stripe invoice
  is marked reconciled against that WeldBooks invoice.
- Invoice PDFs (`invoice_pdf`) are copied to R2 during ingest (`attachmentKeys`),
  like Moneybird attachments.
- Imported invoices do not post journal entries (same as every connector import):
  Moneybird stays the books of record.

Delivery (hybrid):
- **OAuth connections**: Stripe sends connected-account events to the platform's
  Connect webhook, `POST https://integration-webhooks[-test].weldsuite.org/webhooks/stripe-connect`.
  `integration-webhook-worker` verifies `Stripe-Signature` with
  `STRIPE_CONNECT_WEBHOOK_SECRET`, resolves `event.account` through KV
  `stripeacct:{acct}` (a list of `{ workspaceId, connectionId }`), and forwards to
  connect-api `connector-event` with `x-weldsuite-stripe-connect: verified`.
- **API-key connections**: we register a webhook endpoint on the account
  (`POST /v1/webhook_endpoints`) delivering to `/webhooks/connectors/:connectionId`;
  `stripe-signature` is verified with the endpoint secret.
- Events: `invoice.finalized|updated|paid|voided|marked_uncollectible` →
  `stripe-invoices` (the invoice is re-fetched with full lines);
  `payout.paid` → `stripe-balance-transactions` (the payout's transactions are fetched);
  `account.application.deauthorized` → connection `auth_error`.
- Catch-up: the existing D1 sweep probes `/v1/events` since the watermark.

### WeldBooks → Moneybird (push on the Moneybird connection)

`packages/domains/connect/src/connectors/moneybird-push.ts`, run after every
Stripe ingest (sync, webhook, catch-up) and on "Send now".

1. Invoices from the source Stripe connections with no
   `moneybird_external_sales_invoice` mapping on this Moneybird connection
   (claimed with a `pending:` mapping row so concurrent passes don't double-push).
2. Contact: existing `moneybird_contact` mapping → search Moneybird by email →
   create. The mapping uses the inbound type, so the Moneybird contact sync updates
   the same party instead of duplicating it.
3. `POST external_sales_invoices` (lines excl. tax, tax rate per line, revenue
   ledger), then attach the PDF. A cent difference against Stripe's total is
   settled with a `rounding_error` payment.
4. Per paid payout with no `moneybird_financial_statement` mapping: one financial
   statement on the configured Moneybird "Stripe" account. Lines: each gross
   charge, refunds/adjustments, one aggregated fee line, the payout. The
   statement is recorded as soon as Moneybird returns it; each line gets a
   `moneybird_pushed_mutation` row (`todo:…`) and is booked in a separate,
   resumable step: charge → payment on the external invoice with
   `financial_mutation_id`; fees and payout → `link_booking` on their ledger
   (positive amount = the mutation's own direction). Lines that can't be
   linked (refunds, disputes) stay open in Moneybird. A payout waits while an
   invoice it paid is still on its way. Without a Stripe account configured,
   paid invoices are marked paid directly.
   A pass spends at most 100 Moneybird requests; leftover work sets a
   `moneybird_push` row in D1 `tenant_work_index` and the `*/10` cron of
   integration-webhook-worker runs another pass.
5. The Moneybird inbound sync skips the configured Stripe financial account, so
   the statement doesn't come back into WeldBooks as a second bank account.

Runs are logged as `connector_sync_runs` on the Moneybird connection
(`syncName: moneybird-push`), with error samples per invoice.

## API contract (connect-api, `/api/connectors`)

Connection objects (`GET /connections/:id`, catalog entries) gain `settings`:

```ts
interface ConnectorConnectionSettings {
  importStartDate?: string | null;          // Stripe, YYYY-MM-DD
  moneybirdPush?: MoneybirdPushSettings | null;
}
interface MoneybirdPushSettings {
  enabled: boolean;
  sourceConnectionIds: string[];            // Stripe connection ids; [] = all
  revenueLedgerAccountId: string | null;    // required when enabled
  financialAccountId: string | null;        // Moneybird "Stripe" account; null = invoices only
  feeLedgerAccountId: string | null;
  payoutLedgerAccountId: string | null;
  taxRateOverrides: {
    reverseCharge: string | null;
    outsideEu: string | null;
    exempt: string | null;
    noTax: string | null;
  };
  startDate: string | null;                 // YYYY-MM-DD, only invoices issued on/after
}
```

| Method + path | Body / response |
|---|---|
| `POST /authorize` | `+ { provider: 'stripe', returnUrl, displayName?, enabledSyncs?, entityId?, importStartDate? }` → `{ authorizeUrl }` |
| `POST /oauth/callback` | `{ provider: 'stripe' \| 'moneybird', code, state }` → `{ connection, administrations, needsPicker, returnUrl }` (Stripe: `administrations: []`, `needsPicker: false`) |
| `POST /connect` | `+ entityId?, settings?` — Stripe API-key fallback: `{ provider: 'stripe', credentials: { apiKey }, entityId, settings: { importStartDate } }` |
| `PATCH /connections/:id` | `+ settings?: Partial<ConnectorConnectionSettings>` (shallow merge per key) |
| `GET /connections/:id/moneybird/options` | `{ ledgerAccounts: {id,name,accountType}[], financialAccounts: {id,name,type,identifier}[], taxRates: {id,name,percentage,taxRateType}[], stripeConnections: {id,displayName,externalAccountId}[] }` |
| `GET /connections/:id/moneybird/push-status` | `{ enabled, pushedInvoices, pendingInvoices, pushedPayouts, pendingPayouts, lastRun: { status, startedAt, finishedAt, error, errorSamples } \| null }` |
| `POST /connections/:id/moneybird/push` | starts a push pass → `{ started: true }` |

The Stripe OAuth state is prefixed `stripe_`, so the shared callback page
(`/weldconnect/connectors/callback`) knows which provider to complete.

## Configuration

| Name | Worker | Notes |
|---|---|---|
| `STRIPE_CONNECT_CLIENT_ID` | connect-api | `ca_…` of the platform (test and live differ) |
| `STRIPE_SECRET_KEY` | connect-api, integration-sync-worker | platform key: OAuth code exchange, deauthorize, `Stripe-Account` calls |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | integration-webhook-worker | signing secret of the platform's Connect webhook endpoint |

Stripe dashboard (platform account), once per environment:
1. Connect → Settings → enable OAuth for Standard accounts; add redirect URI
   `https://app[-test].weldsuite.org/weldconnect/connectors/callback`.
2. Developers → Webhooks → add endpoint "Listen to events on Connected accounts":
   `https://integration-webhooks[-test].weldsuite.org/webhooks/stripe-connect`,
   events `invoice.*`, `payout.paid`, `account.application.deauthorized`.

Moneybird, once: add a financial account "Stripe" (Bank → add account → other)
and pick it, plus the revenue, fee and transfer ledgers, on the Moneybird
connection.

## Not in scope

Refunds/credit notes, Checkout payments without an invoice, multi-currency
conversion in Moneybird (non-EUR invoices go over as-is), disputes.
