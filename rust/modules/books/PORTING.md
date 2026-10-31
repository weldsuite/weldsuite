# Porting WeldBooks to Rust

The plan for porting `apps/workers/books-api` (WeldBooks, module id `books`)
and `packages/domains/books` (`@weldsuite/books-domain`) to the Rust backend,
for the Kubernetes editions (ADR API-014). Global keeps the TypeScript worker.
Rules and how-to: `rust/docs/porting.md`; the phase plan is P8 wave A in the
docs repo (`design/platform/editions-and-self-hosting-phases.md`).

Books is ported by several agents in parallel, one **area** each, on top of a
**foundation** (the ledger area plus the shared crate). This file is the
contract between them: which crate owns what, which shared code lives where,
the order, and the conformance suites. Keep it up to date when you finish a
piece (the status columns).

## Size

| | TypeScript | Notes |
|---|---|---|
| books-api routes | 55 route files in 44 groups, **379 method+path routes** (361 in the conformance inventory) | `src/routes/*` |
| books-api services | ~27,600 lines | `src/services/*`, `src/lib/*` |
| books-domain | ~26,000 lines | jurisdictions NL/IN/US/BR, sales tax engine, US compliance, invoice templates |
| tests | 77 files; 47 mount routes with `createTestApp` (pglite) | 284 of 361 routes reached (baseline, before the port) |
| crons | 1 trigger, `0 3 * * *` (`cron/books-sweep.ts`) | overdue invoices, recurring invoices, ECB rates, US tax reminders, depreciation |
| internal | `BooksInternal` entrypoint: `/internal/bank-connections/*` (integration workers), `/internal/payroll/imports` (hr-api) | no Clerk; trusted by topology |
| public | `/public/w9/:token`, `/public/fiscal-webhooks/:token` | the token is the credential |

## Crates

```
rust/crates/books-domain/        weldsuite-books-domain       everything shared: tables, JS semantics, the request
                                                              glue (Caller, Refusal, validation, paging), entity
                                                              context, guards, the posting engine, currency/FX,
                                                              jurisdictions, and every service two areas (or another
                                                              module: commerce, hr, connect) need
rust/modules/books/              weldsuite-books              area 0, the foundation: entities, settings, GL accounts,
                                                              journal entries, fiscal periods, tax rates, FX rates,
                                                              dimensions
rust/modules/books-sales/        weldsuite-books-sales        area 1
rust/modules/books-purchases/    weldsuite-books-purchases    area 2
rust/modules/books-banking/      weldsuite-books-banking      area 3
rust/modules/books-sales-tax/    weldsuite-books-sales-tax    area 4
rust/modules/books-reports/      weldsuite-books-reports      area 5
rust/modules/books-tax/          weldsuite-books-tax          area 6
```

One crate per area, like core is split into `core-*`: an area agent works in
its own crate (own compile, own files) and touches shared files only to add a
line. Module crates never depend on each other; everything two crates need is
in `weldsuite-books-domain`. The ledger crate is `rust/modules/books`
itself, next to this plan.

### How an area crate is built

Copy `rust/modules/books` as the template:

- `Cargo.toml`: the same dependencies (add what you use). Add the crate to
  `[workspace.dependencies]` in `rust/Cargo.toml` and to
  `bins/weldsuite/Cargo.toml`.
- `src/lib.rs`: `pub fn routers<S, Q>(state: &BooksState, gate: &Arc<PermissionGate<Q>>) -> Vec<(&'static str, Router<S>)>`,
  one `(prefix, router)` per route group, the prefix as books-api's
  `src/index.ts` mounts it under `/api` (`"/invoices"`). One file per route
  group (`src/invoices.rs`, or `src/invoices/mod.rs` + submodules for a big
  one), each with `pub(crate) fn router<S, Q>(state, gate) -> Router<S>`.
- Mount it: one line in `bins/weldsuite/src/routes/books.rs`
  (`routers.extend(weldsuite_books_sales::routers(&books, gate));`). Public
  routes (`/public/*`) go in that file's `public` function.
- Handlers take `Caller` (`weldsuite_books_domain::http::Caller`) and
  `State<BooksState>`; answer with `reply(result, "<the route's
  error.internal message>")`, read bodies with `validate`, queries with
  `Query`. `books/src/fx_rates.rs` is a small complete group,
  `books/src/journal_entries.rs` one that posts.
- Rows: `weldsuite_books_domain::tables::<TABLE>` (generated for the tables
  books reads and writes, `crates/books-domain/tools/tables.mts`) gives
  Drizzle's row shape (`numeric` as text, `timestamp` as `toISOString()`,
  `date` as `YYYY-MM-DD`), and the insert/patch statements for
  `{ id, ...data }` passthrough bodies. Add a table to the generator's list
  and regenerate when you need one that is missing.

`BooksState` (in `books_domain::http`) carries every port any area needs
(events, files, master DB, outbound HTTP, cache, realtime, jobs). Take what
you need from it; add a field only if no existing one fits.

## Areas

Route counts are method+path. "Unreached" is the baseline coverage of the
worker's own tests (`pnpm rust:conformance --coverage apps/workers/books-api`):
those routes need new pglite tests (refusals included) before the area's
suite can pass. Sizes are TypeScript lines of the routes, their services and
the books-domain code only they use.

### 0. Ledger (foundation) — `books` (ledger)

| Group | Routes | Unreached (baseline) |
|---|---|---|
| `/api/accounting-entities` | 12 | `DELETE /:id` |
| `/api/accounting-settings` | 8 (`PUT`+`PATCH /`) | all but `POST /posting-catch-up` |
| `/api/gl-accounts` | 8 (`PUT`+`PATCH /:id`) | `GET /:id`, `PUT /:id`, `DELETE /:id`, `GET /:id/transactions` |
| `/api/journal-entries` | 7 | `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` |
| `/api/fiscal-periods` | 9 | `GET /:id`, `PATCH /:id`, `DELETE /:id` |
| `/api/tax-rates` | 6 (`PUT`+`PATCH /:id`) | `GET /:id`, `PUT`/`PATCH /:id`, `DELETE /:id` |
| `/api/fx-rates` | 5 | all (no test mounts it) |
| `/api/accounting-dimensions` | 5 | reached only by `accounting-reports/us-reports` (cross-area) |

Services: `lib/entity-context`, `accounting-posting`, `accounting-document-posting`,
`accounting-currency`, `accounting-fx`, `accounting-entity-setup`,
`br-entity-setup`, `accounting-entity-lock`, `accounting-tax-rate-ensure`,
`accounting-catch-up` (+ `accounting-payments`, `accounting-bad-debt`, which it
calls). Every other area's tests create their entity through
`POST /api/accounting-entities`, so this area gates every suite.

### 1. Sales — `books-sales` (~10k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/invoices` | 17 | 2 |
| `/api/recurring-invoices` | 9 | 8 |
| `/api/invoice-templates` | 6 | 0 |
| `/api/payments` | 4 | 1 |

Services: `accounting-invoice-finalize`, `accounting-credit-notes`,
`accounting-recurring`, `invoice-templates`, `br-invoice-render`,
`lib/document-attachment`, `lib/exchange-rate-schema`, `lib/br-fiscal-schemas`,
`sales-tax/{persist,provider-sync,order-invoice}`; books-domain
`accounting-invoice-html`, `invoice-template/*` (layout, pdf, presets),
`accounting-compliance`, `jurisdictions/{in,br}/invoice-format`, `br/pix`.
Owns the shared **tax resolution** (`accounting-tax-resolve`,
`accounting-tax-totals`, `accounting-gst` → `books_domain::tax`), which
purchases, tax and sales-tax use too: port it first. Needs from sales-tax:
`books_domain::sales_tax` (US documents) for the US paths of invoices and
recurring invoices.

### 2. Purchases and payables — `books-purchases` (~15k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/bills` | 10 | 4 |
| `/api/accounting-contacts` | 17 | 5 |
| `/api/accounting-documents` | 10 | 8 |
| `/api/w9-requests` | 4 | 0 |
| `/public/w9` | 2 | public router; its test calls Hono directly |
| `/api/payment-runs` (+ `settings`, `positive-pay`, `checks`, `check-register`) | 21 | 0 |

Services: `accounting-ocr`, `contact-usage`, `vendor-tax-data`, `w9-requests`,
`billing-contact`, `lib/contact-snapshot`, `sales-tax/bill-tax`,
`backup-withholding`, `payment-runs/*`; books-domain `vies`, `identifiers`,
`us-compliance/{nacha,checks,positive-pay,backup-withholding,tin-matching}`.
Owns `books_domain::{contacts (billing-contact, contact-snapshot), vendor_tax}`
(reports and banking read them). OCR runs on `@weldsuite/ai` (Workers AI):
`POST /accounting-documents/:id/process` and `/rematch` are candidates for
`excludedRoutes` + an `UNAVAILABLE_FEATURES` key (`books-ocr`) unless an AI
port exists by then.

### 3. Banking — `books-banking` (~15k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/bank-accounts` | 7 | 1 |
| `/api/bank-transactions` | 13 | 4 |
| `/api/bank-connections` | 12 | 0 |
| `/api/bank-deposits` | 6 | 0 |
| `/api/bank-reconciliations` | 8 | 1 |
| `/api/reconciliation-rules` | 6 | all (no test mounts it) |
| `/internal/bank-connections` (`POST /events`, `POST /:connectionId/sync`) | 2 | internal; called by integration-webhook-worker and integration-sync-worker |

Services: `accounting-bank-*`, `accounting-reconciliation`, `bank-feeds/*`,
`bank-parsers/*` and the `@weldsuite/bank-feeds` package (Plaid, Stripe
Financial Connections, Ponto, Enable Banking: third-party APIs, ported as
outbound calls through `OutboundHttp`; Ponto needs an mTLS client
certificate, a reqwest identity on Kubernetes). Owns
`books_domain::bank_accounts` (payment runs read it).

### 4. US sales tax — `books-sales-tax` (~15k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/sales-tax` (`/settings`, `/reports/*`, `/nexus/*`, `/calculate`, …) | 13 | 1 |
| `/api/sales-tax-agencies`, `-jurisdictions`, `-rules`, `-zones` | 28 | 7 |
| `/api/exemption-certificates` | 6 | 1 |
| `/api/tax-returns` | 18 | 0 |
| `/api/tax-calendar` | 3 | 0 |

Services: `sales-tax/*`, `sales-tax-returns/*`, `sales-tax-reports`,
`nexus-monitor`, `tax-calendar`; books-domain `sales-tax/*` (manual engine,
Avalara and Stripe Tax: outbound calls), `us-compliance/{nexus,tax-calendar}`,
`jurisdictions/us/{sales-tax-return,nexus-thresholds,states,tax-codes}`.
Owns `books_domain::sales_tax` (the engine and `sales-tax/document-tax`):
sales and purchases call it for US documents, and **commerce** calls it for
order tax (`order-sales-tax.ts`). Port the engine first; it unblocks both.

### 5. Reports and US compliance — `books-reports` (~16k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/accounting-reports` | 10 | 1 |
| `/api/accounting-dashboard` | 1 | 0 |
| `/api/accounting-exports` | 1 | 0 |
| `/api/fixed-assets` | 13 | 1 |
| `/api/form-1099` (+ `/filings`) | 21 | 0 |
| `/api/payroll` (+ `/imports`, `/connections`) | 12 | 1 |

Services: `accounting-reports`, `-reports-basis`, `-cash-flow`,
`-report-export`, `-report-periods`, `-tax-worksheet`, `-xaf`,
`fixed-assets/*`, `form-1099/*`, `payroll/*` (Gusto: outbound);
books-domain `us-compliance/{depreciation*,form-1099*,iris-csv}`,
`jurisdictions/us/tax-lines` (the worksheet). The internal payroll import
(hr-api) is in `books_domain::payroll` (below).

### 6. VAT, GST and Brazil — `books-tax` (~10k)

| Group | Routes | Unreached |
|---|---|---|
| `/api/vat-returns` | 10 | 5 |
| `/api/icp-declarations` | 6 | 1 |
| `/api/br-tax` | 4 | 2 |
| `/api/fiscal-documents` | 8 | 0 |
| `/api/received-fiscal-documents` | 9 | 0 |
| `/public/fiscal-webhooks/:token` | 1 | public router, not mounted by a test |

Services: `accounting-digipoort` (Belastingdienst SBR; `DIGIPOORT_MODE`
`simulated` by default, mTLS for `preprod`/`production`),
`accounting-gst-return`, `accounting-icp-xml`, `accounting-tax-ledger`,
`accounting-return-periods`, `br-apuracao`, `br-ecd`, `br-fiscal/*` (Focus NFe:
outbound); books-domain `accounting-vat-xml`, `jurisdictions/nl/{btw-return,taxonomy}`,
`jurisdictions/in/gst-return`, `jurisdictions/br/{apuracao,ecd,tax-engine,simples}`.

### Suggested assignment

Six areas for four or five agents: one agent each for sales, purchases,
banking, US sales tax and reports; the sixth (VAT/GST/Brazil, the smallest)
goes to whichever finishes first, or to a sixth agent. Inside the shared
crate, sales-tax ports `books_domain::sales_tax` and sales ports
`books_domain::tax` before their routes, as the others call them.

## Shared code: `weldsuite-books-domain`

Each row is one module of the crate. Owner = who ports it; a module is added
by one agent only. Status: **done** (ported and used by a passing suite),
**partial** (what the foundation needs; the owner adds the rest), or empty.

| Module | From (TypeScript) | Used by | Owner | Status |
|---|---|---|---|---|
| `tables` (+ `tools/tables.mts`) | `@weldsuite/db/schema`, the books tables | all | foundation | |
| `js` | JS semantics: `Number()`, `toFixed`, `parseInt`, `String(number)`, `Math.round` | all | foundation | |
| `http` | `Caller`, `BooksState`, `Refusal`/`Reply`, `validate`, `Query`, paging | all | foundation | |
| `entity_context` | `lib/entity-context` (resolve entity, base currency, number sequences) | all | foundation | |
| `guards` | books-domain `accounting-guards` (closed periods, lock dates, KOR, audit trail) | all | foundation | |
| `posting` | `accounting-posting` (post, reverse, post draft, entity accounts, roles) | all that post | foundation | |
| `currency`, `fx` | `accounting-currency` (ECB feed, stored rates), `accounting-fx` | sales, purchases, banking, tax, reports | foundation | |
| `document_posting` | `accounting-document-posting` (invoice, bill, payment, write-off postings) | sales, purchases, banking, tax | foundation | |
| `payments`, `bad_debt` | `accounting-payments`, `accounting-bad-debt` | sales, banking, purchases, ledger (catch-up) | foundation | |
| `jurisdictions` | `jurisdictions/{registry,types}` + the per-country data the entity setup seeds (charts, tax categories, identifiers, entity types, tax lines, states) | all | foundation | |
| `address`, `roles`, `identifiers` | `accounting-address`, `accounting-roles`, `identifiers` | all, commerce, connect | foundation | |
| `fiscal_year`, `dates` | `us-compliance/{fiscal-year,dates}` | ledger, reports, sales-tax | foundation | |
| `payroll` | `payroll/{imports,weldhr,mapping,journal}`: the internal import hr-api posts | reports (routes), **hr** | foundation | |
| `tax` | `accounting-tax-resolve`, `-tax-totals`, `-gst` | sales, purchases, tax, sales-tax | sales | |
| `sales_tax` | books-domain `sales-tax/*`, `services/sales-tax/{document-tax,errors,runtime,route-helpers}` | sales-tax, sales, purchases, **commerce** | sales-tax | |
| `contacts` | `billing-contact`, `lib/contact-snapshot` | purchases, sales, reports | purchases | |
| `vendor_tax` | `vendor-tax-data`, `w9-requests` (tokens) | purchases, reports (1099), tax (fiscal webhooks) | purchases | |
| `bank_accounts` | `accounting-bank-accounts` | banking, purchases (payment runs) | banking | |
| `reports_basis` | `accounting-reports-basis`, `accounting-report-periods` | reports | reports | |
| `invoice_html` | `accounting-invoice-html`, `invoice-template/*`, `accounting-compliance` | sales, **commerce** (portal invoices) | sales | |

## Order

1. Foundation: the shared modules marked foundation, `books` (ledger) with its
   suite at zero differences, the books routers mounted behind
   `mounts("books")` (conformance builds always mount them; production only
   once `books` is marked ported).
2. In parallel: sales-tax starts with `books_domain::sales_tax`; sales with
   `books_domain::tax`; purchases with `contacts` and `vendor_tax`; banking
   and reports with their own groups. Every area can start with the groups
   whose services are its own.
3. Cross-area suites (below) last, when every area they touch is ported.
4. The cron and `RUST_PORTED_MODULES`: when every suite is green and every
   route reached or excluded.

## Conformance suites

One or more suites per area in `rust/conformance/suites.json`, `module:
"books"`, `workspace: "apps/workers/books-api"`, named `books: <area>[: …]`.
`paths` lists the area's route dirs, its services, `packages/domains/books/src/`,
`rust/modules/books-<area>/` and `rust/crates/books-domain/`.

A test file belongs to the suite of the **last** area it needs: a file that
mounts invoices and bank transactions can only pass when both are ported.

| Test file | Areas it mounts | Suite |
|---|---|---|
| `routes/accounting-entities/{integration,entity-lock,lock-dates,us-setup}` | ledger | `books: ledger` |
| `routes/gl-accounts/*`, `routes/tax-rates/*`, `routes/fiscal-periods/*`, `routes/fx-rates/*`, `routes/journal-entries/*`, `routes/accounting-settings/*`, `routes/accounting-dimensions/*` | ledger | `books: ledger` |
| `routes/invoices/{integration,index}`, `routes/invoice-templates/*`, `routes/recurring-invoices/*` | sales | `books: sales` |
| `routes/invoices/{document-integrity,india-gst}`, `services/{accounting-fx,bad-debt-vat}.integration` | sales, purchases (bills), reports, tax (vat-returns) | `books: cross-area` |
| `routes/invoices/brazil` | sales, purchases, tax (br-tax) | `books: cross-area` |
| `routes/bills/*`, `routes/accounting-contacts/*`, `routes/accounting-documents/*`, `routes/w9-requests/*`, `routes/public-w9/*` | purchases | `books: purchases` |
| `routes/payment-runs/*` | purchases, banking (bank-accounts) | `books: purchases`, after banking |
| `routes/bank-*/*` | banking | `books: banking` |
| `services/accounting-us-banking.integration` | banking, sales, purchases | `books: cross-area` |
| `routes/sales-tax*/*`, `routes/exemption-certificates/*`, `routes/tax-returns/*`, `routes/tax-calendar/*`, `routes/sales-tax-setup.integration` | sales-tax | `books: sales-tax` |
| `services/sales-tax/us-{documents,provider}.integration` | sales-tax, sales, purchases | `books: cross-area` |
| `routes/accounting-reports/*`, `routes/accounting-dashboard/*`, `routes/accounting-exports/*`, `services/fixed-assets/*`, `routes/form-1099/*`, `routes/payroll/payroll` | reports (+ ledger) | `books: reports` |
| `routes/accounting-reports/us-reports` | reports, sales, purchases, sales-tax | `books: cross-area` |
| `routes/fiscal-documents/*`, `routes/received-fiscal-documents/*`, `services/btw-return-lifecycle.integration` | tax (+ sales) | `books: tax` |
| `services/accounting-ledger.integration` | every area | `books: cross-area` |
| `routes/_sweeps.test.ts` | every route group (auth gates, list sweeps) | `books: cross-area` |

Not conformance tests (they call services or a bare Hono app, not
`createTestApp`): `routes/payroll/internal`, `cron/tax-reminders`,
`services/**/*.test.ts` without `createTestApp`. Port their behaviour with
Rust unit tests, or add a `createTestApp`/`conformanceSweep` test.

## Internal and public routes

- `/internal/payroll/imports` (hr-api, `BOOKS_INTERNAL`): on Kubernetes hr
  and books run in one process, so the Rust hr module calls
  `weldsuite_books_domain::payroll::post_weldhr_import(&tenant_db, input)`
  directly (the route's input, `BooksPayrollPost` in hr-api's
  `services/weldhr/payroll/deps.ts`, and its answer, `{ importId,
  journalEntryId, entryNumber, payDate, duplicate, status }` or the
  refusal), and the route itself is a thin wrapper over it. No service
  binding and no `X-Workspace-Id`: hr passes its own tenant database.
- `/internal/bank-connections/{events,:id/sync}` (integration workers): the
  same idea when those workers are ported (P8 wave C):
  `books_domain::bank_feeds` functions.
- `/public/w9/:token`, `/public/fiscal-webhooks/:token`: outside the session
  and tenant layers; the token resolves the workspace. Merge them through
  `routes::books::public` (`server.rs` merges `routes::public`).

## Cron

`books-sweep` (`0 3 * * *`): `weldsuite cron books-sweep` + a chart
`cron.jobs` entry, after sales (overdue, recurring), sales-tax (reminders)
and reports (depreciation) are ported. The KV index of active workspaces
(`books:active:<org>`, written by an `/api/*` middleware on every request)
becomes the master due index (`weldsuite_db::due_index`, kind `books`, keyed
by `workspaces.id`): mark it from the same middleware.

## Third-party APIs and Cloudflare-only features

Ported as outbound calls (`OutboundHttp`, compared in conformance through the
outbound bridge): ECB rates, VIES, Avalara, Stripe Tax, Focus NFe, Plaid,
Stripe Financial Connections, Ponto (mTLS), Enable Banking, Gusto, Digipoort
(mTLS; `simulated` needs nothing). Candidate for `UNAVAILABLE_FEATURES`
(Cloudflare-only): accounting document OCR (Workers AI through `@weldsuite/ai`).

## Other modules that use books

- **commerce** (`order-sales-tax.ts`, `commerce-portal-invoices.ts`):
  `address::normalize_postal_address`, `jurisdictions::features`,
  `sales_tax` (engine + `load`), US tax codes, `invoice_html`,
  `accounting-compliance`. Address and jurisdiction features are in the
  foundation; the engine comes with the sales-tax area, invoice HTML with
  sales.
- **connect** (`connectors/ingest.ts`): `roles::promote_accounting_role`
  (foundation).
- **hr**: `payroll::post_weldhr_import` (foundation; see above).

## Status

| Piece | Status |
|---|---|
| Plan (this file) | done |
| `books-domain` foundation modules | in progress |
| `books` (ledger) and the `books: ledger` suite | in progress |
| Areas 1–6 | not started |
| Cron, `RUST_PORTED_MODULES` | not started |
