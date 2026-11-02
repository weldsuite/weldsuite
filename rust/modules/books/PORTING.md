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

### What the foundation learned (read before porting a group)

- Rows: select with `concat!("select ", books_row!(<table>), " from <table> t …")`
  (sqlx takes literal SQL only) and pass them through `<TABLE>.js(row)`.
  `numeric` comes back as text (`"121.00"`), `timestamp` as `toISOString()`,
  `date` as `YYYY-MM-DD`, exactly as Drizzle hands them to the route.
- Writes of a body: `<TABLE>.values(&data)` keeps the table's properties
  (Drizzle drops the rest); `<TABLE>.insert(db, values, &["createdAt", …])`
  makes a `Date` column the body set throw, as Drizzle's `toISOString` does;
  `insert_raw` / `patch_raw` for values the route built itself.
- Answer with what TypeScript answers: many routes return the object they
  built (`{ id, ...data, createdAt }`, raw strings like `debit: "100"`), not
  the stored row. A key the route leaves `undefined` is absent in the JSON.
- `serde_json` sorts object keys; the conformance diff doesn't care, but a
  route that compares `JSON.stringify` results does (a `jsonb` column comes
  back shorter keys first): see `fiscal_year_changed` in
  `books/src/accounting_entities/mod.rs`.
- Zod details matter on a 400: issue order (refinements last, an object
  refinement skipped when a field has a type error, see `tax_rates.rs`),
  `.length(n)` is `Issues::string_length`, `.trim()` is `Text::trimmed`.
- Money is JavaScript arithmetic: `js::round_money`, `js::to_fixed` (ties
  away from zero, `-0.00` kept), `js::parse_float`, `js::number_text`.
- Errors: `PostError::user_message()` is what the routes answer with a 400
  (`ClosedPeriodError | LockedPeriodError | PostingError`); a database error
  is the route's 500.
- The harness records a test's own `ENTITY_EVENTS` binding (forwarding to it),
  and forwards `DATABASE_ENCRYPTION_KEY(_V2)` to Rust (`caller.keyring`).
- Documents post through `books_domain::document_posting` (`build_*_posting`,
  `post_invoice`, `post_bill`, `build_payment_posting`, `settle`),
  `payments::{record_payment, void_payment}` and
  `bad_debt::{write_off_invoice, post_bad_debt_recovery}`. They take rows as
  `Value`s from `<TABLE>.js(row)`, and an `Option<&OutboundHttp>`
  (`caller.http(&state)`) for the ECB feed a foreign document may need.
  `alsoWrite` is a `Vec<AlsoWrite>`; `document_posting::update_with_entry`
  writes a row with the new entry's id.
- The ECB rates are cached per `caller.rate_scope()`: one cache for the app,
  one per test file under conformance (as the worker's module variable).
- A `GET` that writes (the settings row on first read) goes in
  `WRITING_READS` in `worker-kit/src/testing/conformance.ts`; a value stamped
  with the time (`fetchedAt`) in `conformance-volatile.ts`.
- Workspace clippy is pedantic with `-D warnings`: a function that mirrors a
  long TypeScript one carries `#[allow(clippy::too_many_lines)]` with a reason;
  tests use `expect`, not `unwrap`.
- A quick loop: build `weldsuite` with `--features conformance`, start it
  with the env of `D:/ws-rust-targets/tools/integ-conf.mjs`, and run the test
  files with `CONFORMANCE_TARGET=rust CONFORMANCE_STRICT=0
  CONFORMANCE_REPORT_DIR=<dir>`; the `.jsonl` lines in the report dir list
  every difference.

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

**Status: ported.** All 52 routes of the six groups in `weldsuite-books-banking`;
the `books: banking` suite (7 test files, 355 requests) at zero differences
and zero schema failures, every route reached (the unreached ones above got
tests: `bank-accounts`, `reconciliation-rules`, `bank-transactions/matching`,
`bank-deposits`, `bank-reconciliations`, `bank-connections` integration
tests). The bank-feed providers run against their real HTTP APIs answered
by a `fetch` stub, compared through the outbound bridge: Plaid and Stripe
Financial Connections end to end, Ponto and Enable Banking from completing
a link to disconnecting or deleting it, Enable Banking's bank list. Ponto's
and Enable Banking's link sessions carry a random `state` (and a time-based
consent end), so their outbound calls cannot match; the test starts Plaid
and Stripe links only. Ponto's mTLS
client is `BooksState::ponto_http`, made from `PONTO_MTLS_CERT` and
`PONTO_MTLS_KEY` (`ReqwestOutbound::with_client_certificate`). Bank-connection
billing is Global's billing-worker: off on these editions (the `billing`
feature), so `GET /billing` is `null` and no connection is limited or
charged, as the worker answers where billing is off. The two internal
routes are `bank_feeds::events::apply_events` and
`bank_feeds::sync::sync_connection` (real-schema test
`crates/books-domain/tests/bank_feeds.rs`), for the integration workers'
port (P8 wave C).

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
| `tables` (+ `tools/tables.mts`) | `@weldsuite/db/schema`, the books tables | all | foundation | done |
| `js` | JS semantics: `Number()`, `toFixed`, `parseInt`, `String(number)`, `Math.round` | all | foundation | done |
| `http` | `Caller`, `BooksState`, `Refusal`/`Reply`, `validate`, `Query`, paging | all | foundation | done |
| `entity_context` | `lib/entity-context` (resolve entity, base currency, number sequences) | all | foundation | done |
| `guards` | books-domain `accounting-guards` (closed periods, lock dates, KOR, audit trail) | all | foundation | done |
| `posting` | `accounting-posting` (post, reverse, post draft, entity accounts, roles) | all that post | foundation | done |
| `currency`, `fx` | `accounting-currency` (ECB feed, stored rates), `accounting-fx` | sales, purchases, banking, tax, reports | foundation | done |
| `document_posting` | `accounting-document-posting` (invoice, bill, payment, write-off postings, settlement) | sales, purchases, banking, tax | foundation | done |
| `payments`, `bad_debt` | `accounting-payments` (record, void, FX differences, deposit target), `accounting-bad-debt` (write-off with VAT relief, recovery) | sales, banking, purchases, ledger (catch-up) | foundation | done |
| `catch_up` | `accounting-catch-up` | ledger (`/api/accounting-settings/posting-catch-up`) | foundation | done |
| `sales_tax` (posting part) | books-domain `sales-tax/{rounding,sourcing,to-tax-lines}` (the helpers posting needs), `pickShipTo` | posting; the sales-tax area extends it | foundation | done: `to_cents`, `allocate_cents`, `round_half_up`, `state_code_of`, `zip5_of`, `pick_ship_to`, `breakdown_to_tax_line_fields`; `jurisdictions::us::{states, state}` carry the full `US_STATES` data |
| `jurisdictions` | `jurisdictions/{registry,types}` + the per-country data the entity setup seeds (charts, tax categories, identifiers, entity types, tax lines, states) | all | foundation | partial: registry, summaries, seed charts and rates, identifier checks of the four countries, US entity kinds and tax lines (invoice formats, returns and tax engines come with their areas); from the tax area: Brazil's document tax engine (`jurisdictions::br_tax`: `computeBrDocumentTaxes` with the states' ICMS rates, the regimes' PIS/COFINS and `crtOf`, `suggestBrWithholdings`). The Dutch rubrieken and XBRL, the GST worksheet, the apuração and Simples DAS and the SPED ECD are only the tax area's and live in `books-tax` |
| `address`, `roles`, `identifiers` | `accounting-address`, `accounting-roles`, `identifiers` | all, commerce, connect | foundation | done: addresses, `roles::promote_accounting_role`, IBANs; the VAT-number formats (`check_vat_number_format`, `vat_example`, `iban_length`) and `vies` (`check_vat_number`, VIES through the outbound port, cached in `vies_checks`) came with the purchases area |
| `fiscal_year`, `dates` | `us-compliance/{fiscal-year,dates}` | ledger, reports, sales-tax | foundation | done |
| `payroll` | `payroll/{imports,weldhr,mapping,journal}`: the internal import hr-api posts | reports (routes), **hr** | foundation | done: `post_weldhr_import` (hr), `post_payroll_import`, `reverse_payroll_import`, `Resolver`. The CSV and Gusto line builders (`buildPayrollLines`, `buildGlLines`), the CSV parser and the Gusto client live in `books-reports` (`src/payroll/`): only the payroll routes use them |
| `tax` | `accounting-tax-resolve`, `-tax-totals`, `-gst` | sales, purchases, tax, sales-tax | sales | done: `calculate_document_tax` (rate table, India's split, self-assessed purchases, the US and hook paths), `untaxed_document_tax`, `load_place_of_supply`, `resolve_gst_supply`, `resolve_gst_bill_supply`, `totals::{calculate_line_tax_totals, hook_inputs, hook_tax_totals}`; tested on the real schema (`tests/tax.rs`). Two seams for other areas: Brazil's `computeDocumentTaxes` plugs into `tax::document_tax_hook` (tax area; a BR document fails until then), the US engine into `sales_tax::document_tax` (below) |
| `sales_tax` | books-domain `sales-tax/*`, `services/sales-tax/{document-tax,errors,runtime,route-helpers}` | sales-tax, sales, purchases, **commerce** | sales-tax | done: the engines (`engine::{Engine, create_engine}`: `manual`, `stripe` and `avalara`, the providers through `OutboundHttp`: calculate, commit, reverse, void, address validation, provider registrations), `load` (engine, sealed credentials, registrations, manual data, customer certificates), `sourcing`, `zones`, `exemptions`, `rounding`, `dates`, `common`, `tax_codes`, `to_tax_lines` (breakdown rows, ledger columns, a credit memo from its invoice), `document_tax` (`calculate_us_document_tax`, `accrue_use_tax`, `build_stored_request`, `resolve_line_tax_code`, `ship_to_incomplete`), `errors`, `route_helpers`. books-sales' `provider_sync` runs on it (commit, reverse). Tested by `books: sales-tax` (the calculation preview, the provider checks) and the US paths of `services/sales-tax/us-documents` (invoices at zero differences; its bills wait for purchases) |
| `sales_tax::worksheet` | `jurisdictions/us/sales-tax-return` (the return worksheet per agency and period, its CSV artifact) | sales-tax (`/api/tax-returns`) | sales-tax | done: `build_us_sales_tax_worksheet`, `build_us_sales_tax_return`, `WorksheetLine` (`toWorksheetLine`'s shape), `level_rank`; unit-tested, and through `books: sales-tax` |
| `nexus` | `us-compliance/nexus`, `jurisdictions/us/nexus-thresholds` (`NEXUS_RULES`, exported into `data/jurisdictions.json` by `tools/export.mts`) | sales-tax (`/api/sales-tax/nexus`), the cron (nexus reminders) | sales-tax | done: `get_nexus_rule`, `nexus_monitored_codes`, `measure_nexus`, `nexus_monitor`, `apply_collection_start` (every window: calendar years, rolling 12 months, tested quarterly, NY quarters, Connecticut) |
| `tax_calendar` | `us-compliance/{tax-calendar,federal-holidays}` | sales-tax (calendar, return periods), reports (1099 deadlines roll on `roll_to_business_day`), the cron (tax reminders) | sales-tax | done: `tax_calendar`, `agency_deadlines`, the income tax, estimated tax, 1099 and payroll deadlines, `roll_to_business_day`, `is_legal_holiday`, `date_in` |
| `contacts` | `billing-contact`, `lib/contact-snapshot` | purchases, sales, reports | purchases | done: `load_billing_contacts`, `set_billing_contact`, `clear_billing_contact`, `load_contact_snapshot`, `document_contact_fields`, `with_contact_names`; real-schema test `tests/purchases_domain.rs` |
| `vendor_tax` | `vendor-tax-data`, `w9-requests` (tokens) | purchases, reports (1099), tax (fiscal webhooks) | purchases | done: `read_vendor_tax` (the schema fields), `build_vendor_tax_change`, `read_sensitive`, `decrypt_party_tin`, `reveal_party_secret`, `vendor_tax_derived`, `strip_tax_fields_for_event`; the W-9 tokens (`generate_w9_token`, `sha256_hex`, `w9_kv_key`, `w9_url`, `to_w9_request_view`, `w9_event_data`); the US identifiers they need (`validate_tin`, `validate_itin`, `validate_routing_number`, `format_tin`, `is_allocatable_box`, `is_corporation_classification`) |
| `nacha`, `checks`, `positive_pay` | `us-compliance/{nacha,checks,positive-pay}` | purchases (payment runs) | purchases | done: `build_nacha_file`, `verify_nacha_file`, `aba_checksum_valid`, `company_id_from_ein`, `is_ach_banking_day`, `suggest_effective_entry_date`, `build_rmr_segments`; `amount_in_words`, `courtesy_amount`, `build_micr_fields`/`build_micr_line`, `fractional_routing`, `get_check_layout`, `CHECK_LAYOUTS`; `build_positive_pay_file`, `POSITIVE_PAY_FORMATS` (`positive_pay_formats_json`); `dates::{nth_weekday_of_month, last_weekday_of_month}` came with them |
| `backup_withholding` | `us-compliance/backup-withholding`, books-api `services/backup-withholding` | purchases (payment runs), reports (Form 945) | purchases | done: `backup_withholding_detail`, `compute_backup_withholding` (the vendor's default box and its year-to-date threshold, `box_threshold`), `BACKUP_WITHHOLDING_RATE`. `form945Summary` came with the reports area as `form_1099::form_945_summary` |
| `bank_accounts` | `accounting-bank-accounts` (+ `bank-feeds/ledger`) | banking, purchases (payment runs) | banking | done: `is_valid_aba_routing`, `normalize_account_number`, `public_bank_account`, `seal_account_number`, `reveal_account_number` (`BankAccountError::Posting` is the routes' 400, `NoKey` their 500 with `NO_KEY_MESSAGE`), `assert_ledger_account_fits`, `plan_bank_ledger_account`, `create_ledger_account_for_bank`; real-schema test `tests/bank_accounts.rs` |
| `bank_matching` | `accounting-reconciliation` (candidates, suggestions, reconcile to an invoice, bill, payment or deposit, unreconcile, auto-reconcile) | banking (transactions, the feed sync) | banking | done: `find_matches`, `reconcile_to_document`, `reconcile_to_payment`, `reconcile_to_deposit`, `unreconcile`, `auto_reconcile_batch` |
| `bank_feeds` | `services/bank-feeds/*`, `@weldsuite/bank-feeds` (Plaid, Stripe FC, Ponto, Enable Banking), the internal sync and events | banking; the integration workers (wave C) | banking | done: `FeedContext`, `providers::Provider`, `connections::*` (views, link session, complete, map, disconnect, delete, pending), `sync::sync_connection`, `events::{apply_feed_event, apply_events}`; real-schema test `tests/bank_feeds.rs` |
| `reports_basis` | `accounting-reports-basis`, `accounting-report-periods` | reports | reports | done: `ledger` (`create_ledger`, accrual and cash: pro-rata recognition of document lines at payment, unapplied payments on the virtual accounts, voided payments left out; `aggregate`, `account_lines`), `periods` (fiscal-year defaults, `prior_period_of` / `prior_year_of`, period, point-in-time and month/quarter columns, `today_for` in the entity's time zone), `parse_report_date`, `money`, `numeric_compare` (`localeCompare(…, { numeric: true })`) |
| `depreciation` | `us-compliance/{depreciation,depreciation-tables}` | reports (fixed assets) | reports | done: `depreciation_schedule`, `monthly_schedule`, `depreciation_basis` (book methods, MACRS GDS tables A-1 to A-7a, ADS, section 179 and its yearly limits, bonus by acquisition date, de minimis), `mid_quarter_test`, `macrs_conventions`, `gain_on_disposal`, `disposal_year_fraction`, `en_us` (`toLocaleString('en-US')`); unit tests against the TypeScript examples |
| `form_1099` | `jurisdictions/us/form-1099`, `us-compliance/{form-1099-compute,form-1099-pdf-data,iris-csv,tin-matching}`, the Form 945 summary of `us-compliance/backup-withholding` | reports (1099) | reports | done: boxes, thresholds by tax year, due dates (`roll_to_business_day` of `tax_calendar`), the e-file and Form 8508 rules, state filing rules; `compute::compute_1099_totals` (cash basis, pro-rata over bill lines, largest remainder, the corporation rule, backup withholding to box 4), `iris::generate_iris_csv` (IRS templates or a downloaded header row), `pdf::form_1099_pdf_copies`, `tin_matching::{build_files, parse_results}`, `form_945_summary`, `usd` |
| `invoice_html`, `compliance` | `accounting-invoice-html`, `invoice-template/*`, `accounting-compliance` | sales, **commerce** (portal invoices) | sales | done: `generate_invoice_html`, `invoice_template_data`, `generate_templated_invoice_html` (`layout`, `svg`, `mobile`), Node's `Intl` money/number/date shapes and the PDF font metrics exported by `tools/invoice-export.mts` into `data/invoice.json` (checked against 3440 Node outputs, `data/intl-cases.json`); `compliance`: notices, `validate_invoice_for_finalize`, missing entity fields. Not yet: Brazil's Pix QR (`jurisdictions/br/pix`, uqr) — a BR invoice prints without the Pix block; VIES (`compliance::check_vat_number`) goes through `vies` (purchases) |
| `attachments` | `lib/document-attachment` | sales, purchases (bills) | sales | done: `stream_document_attachment`, `is_workspace_object_key` |

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
| `routes/invoices/{integration,index,lifecycle}`, `routes/invoice-templates/*`, `routes/recurring-invoices/crud`, `routes/payments/payments` | sales (+ ledger: entities are created through it) | `books: sales` |
| `routes/recurring-invoices/integration` | sales, sales-tax (its entities are US: the engine answers) | `books: cross-area` |
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
  `weldsuite_books_domain::payroll::post_weldhr_import(&tenant_db, input,
  Some("system"))` directly. Its input, `payroll::WeldHrImport`, is hr-api's
  `BooksPayrollPost` (`services/weldhr/payroll/deps.ts`) after the route's
  validation; its answer, `payroll::WeldHrReply`, is the route's by status:
  `Created { body, event }` (201; hr publishes `PAYROLL_IMPORT_CREATED`
  with `event`, source `system`, in its workspace), `Duplicate(body)` (200),
  `Reversed` (409), `EntityNotFound` (404), `BadRequest(message)` (400), and
  `Err` for the 500. No service binding and no `X-Workspace-Id`: hr passes
  its own tenant database. Done, with a test on the real schema
  (`crates/books-domain/tests/payroll_import.rs`).
- `/internal/bank-connections/{events,:id/sync}` (integration workers): the
  same idea when those workers are ported (P8 wave C). Done:
  `bank_feeds::events::apply_events(ctx, connection_id, events)` (its
  `EventsOutcome::to_json()` is the route's `data`) and
  `bank_feeds::sync::sync_connection(ctx, connection_id, false)` (a
  `skipped: not_found` outcome is the route's 404). The caller builds the
  `FeedContext` for the workspace (its tenant database, the books keyring,
  master, outbound clients, the env's provider config) and publishes
  `BANK_CONNECTION_SYNCED` (source `system`, data `{ id, status, added,
  updated, removed }`) when the sync ran without a skip or an error.
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
| `books-domain` foundation modules | done: the rows marked done above (posting engine, documents, payments, bad debt, catch-up included); payroll (hr's in-process import) and `roles::promote_accounting_role` (connect) included |
| `books` (ledger) and the `books: ledger` suite | all 8 groups ported; 17 test files, 395 requests at zero differences and zero schema failures, every ledger route reached |
| Area 1 (sales) and the `books: sales` suite | all 4 groups ported (36 routes: invoices, payments, recurring invoices, invoice templates); 6 test files, 41 tests, 187 requests at zero differences and zero schema failures, every sales route reached. Left for other areas: the US engine (`sales_tax::document_tax::{calculate_us_document_tax, accrue_use_tax}` stubs answer "engine unavailable"; US invoices draft untaxed and refuse to finalize, provider sync records `commit_failed`), Brazil's document tax hook (`tax::document_tax_hook`, a BR document fails until the tax area plugs the engine in), VIES (purchases), Pix (BR). For the `books-sweep` cron (recurring and overdue invoices), `books-sales`' `recurring::generate_recurring_invoice` takes the request's `Caller` today: the cron needs a variant on a tenant pool and a system user |
| Area 2 (purchases) and the `books: purchases` suite | all 6 groups ported: `/api/accounting-contacts` (17 routes, CRM identities through `crm-domain`), `/api/w9-requests` (4), `/public/w9/:token` (2), `/api/accounting-documents` (10; OCR itself is `books-ocr` in `unavailableFeatures`, its route in `excludedRoutes`), `/api/bills` (10), `/api/payment-runs` (21, with `settings`, `positive-pay`, `checks`, `check-register`: runs, holds, approvals, payments with backup withholding, check numbering, print data, void and reissue, the register, NACHA and Positive Pay files; `books-purchases/src/payment_runs`, books-domain `nacha`, `checks`, `positive_pay`, `backup_withholding`); 16 test files, 179 tests, 540 requests at zero differences and zero schema failures, every route reached. An approval that stops partway is tested with a payments mock on TypeScript; Rust gets the same failure point through the test's env (`CONFORMANCE_FAIL_RECORD_PAYMENT_AFTER`, forwarded only under conformance; the process env never carries it). Left for other areas: US use tax on bills waits for the sales-tax engine (`accrue_use_tax`), Brazil's bill hook for the tax area, `form945Summary` for reports |
| Area 4 (US sales tax) and the `books: sales-tax` suite | all groups ported (68 routes). `books_domain::sales_tax` (engine, worksheet), `books_domain::nexus`, `books_domain::tax_calendar`; groups `/api/sales-tax` (settings, registration check, calculate, validate-address, `/reports/*` (`reports.rs`: liability, sales summary, exceptions, expiring and missing certificates, provider reconciliation), `/nexus` (`nexus.rs`)), `/api/sales-tax-agencies`, `-jurisdictions` (and rates), `-rules`, `-zones`, `/api/exemption-certificates`, `/api/tax-calendar`, `/api/tax-returns` (`returns/`: periods, overview, the returns, calculate, review, documents, pre-file and liability checks, exceptions, CSV export, file, payment, amend, carry forward; `services/sales-tax-returns/*` one file each). Suite: `sales-tax-setup`, `sales-tax-setup-crud`, `tax-calendar`, `sales-tax/reports`, `tax-returns/integration`, `exemption-certificates/certificate-cure`: 6 files, 66 tests, 240 requests at zero differences and zero schema failures, every sales-tax route reached. Cross-area: `services/sales-tax/us-documents` and `us-provider` (now on a global `fetch` stub, so the provider calls are compared; the outbound bridge compares form bodies field by field) differ only on `/api/bills` (purchases). The routes take "today" and every timestamp they write from the request clock (`common::now_of`, the test's faked clock in conformance). Response schemas exist only for the setup routes (`books-sales-tax-responses.ts`); the client package has no types for reports, nexus or returns. For the cron's reminders: `reports::expiring_certificates`, `nexus::nexus_overview`, `returns::periods::build_period_rows` take a pool and a day (crate-private today; make them `pub` when the cron moves in) |
| Area 6 (VAT, GST and Brazil) and the `books: tax` suite | all 6 groups ported in `books-tax` (36 routes: VAT returns with the GST worksheet, ICP declarations, br-tax, fiscal documents, received fiscal documents, and the public Focus webhook `/public/fiscal-webhooks/:token`); 6 test files, 65 tests, 178 requests at zero differences and zero schema failures, every route of the area reached. Digipoort answers as the worker does without its PKIoverheid certificate binding (a simulated submission; `UNAVAILABLE_FEATURES`: `vat-digipoort`, the platform hides filing and the status check). Focus NFe is an outbound call through `OutboundHttp`. Brazil's engine is in `tax::document_tax_hook`; with it `routes/invoices/{brazil,india-gst}` (cross-area) pass on Rust except the Pix block of the printed invoice (sales' `br/pix`, not ported) |
| Area 5 (reports) and the `books: reports` suite | all 6 groups ported (58 routes): `/api/accounting-reports` (11, json/csv/print), `/api/accounting-dashboard`, `/api/accounting-exports` (XAF), `/api/payroll` (12: CSV imports, saved mapping, Gusto through `OutboundHttp`), `/api/fixed-assets` (13: books, schedules, the monthly ledger rows, the depreciation run, disposal with catch-up, register, Form 4562-style tax depreciation, mid-quarter test, de minimis, assets from bill lines), `/api/form-1099` (21: the yearly review, drill-down, deadlines, Form 945, TIN matching, filings with lines, review, generation with sealed TINs, the IRIS file, copies, filing, corrections, delivery). 6 test files (`fixed-assets.integration` and `form-1099.integration` joined, with cases for the fixed asset list and schedule, payroll categories and 1099 filing notes), 109 tests, 411 requests, every route of the area reached, zero schema failures (response schemas in `books-reports-responses.ts`, registered by `conformance-schemas-books-reports.ts`). One difference left: `POST /api/form-1099/filings` answers its lines ordered by `(created_at, id)`, and lines created in the same millisecond get random ids, so the order of a new filing's lines is random on both backends (TypeScript too, run to run); the fix is a deterministic order in TypeScript (a decision for the user). The IRIS file, TIN Matching file and copies are `WRITING_READS` (they log reveals). Routes default dates with `Caller::now_ms` (the test's faked clock in conformance) |
| Cron | `weldsuite cron books-sweep` (chart `cron.jobs.books-sweep`, `0 3 * * *`) on the due index (kind `books`, marked once per process by every books request): overdue invoices, due recurring invoices (`weldsuite_books_sales::generate_recurring_invoice_as_system`, the route's steps as the system user), the day's ECB rates, and the depreciation due through the end of last month (`weldsuite_books_reports::run_monthly_depreciation`; a locked period is skipped and counted). Not yet: the US tax reminders (`cron/tax-reminders.ts`): the sales-tax services they read exist (`returns::{load_agencies, load_agency_returns}`, `returns::periods::build_period_rows`, `calendar`, `reports` (expiring certificates), `nexus::nexus_overview`) but are `pub(crate)` and take a `Caller`; the cron also needs a marker store with a TTL (KV `books:reminder:<org>:<marker>` on Global: the cache port or a table) and the in-app notifier (a `notifications` row per owner and admin plus a realtime publish) |
| Areas 3 | see its branch |
| `RUST_PORTED_MODULES` | not started |
