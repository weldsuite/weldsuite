# WeldBooks Peppol

Send sales invoices and credit notes over the Peppol network, and receive
suppliers' invoices from it as bills, in every edition: Global (TypeScript on
Cloudflare), EU and self-hosted (Rust on Kubernetes). It starts with the
Netherlands and works through an EU access-point provider behind a port, so a
WeldSuite-run access point can replace the provider later without touching the
rest of WeldBooks.

Status: plan, nothing built. Written 2026-11-11.

## Scope decisions (2026-11-11)

| Question | Decision |
|---|---|
| How we reach the network | Through an **EU-owned access-point provider's API**, behind a `PeppolAccessPoint` port in both backends. Our own access point is a later option behind the same port, not part of this plan. |
| Editions | **All three.** WeldBooks is ported, so every phase lands in TypeScript and Rust in the same PR, with conformance suites for the new routes. |
| Directions | **Send and receive** in the first release. |
| Countries at launch | **Netherlands.** Peppol is switched on through the NL jurisdiction adapter. BE and DE need their own adapters first (see "Later"). |
| Document format | Peppol BIS Billing 3.0 (UBL 2.1 Invoice and CreditNote), current version 3.0.21, with the Dutch rules for Dutch senders. |

## Why now

From the research of 2026-11-11 (sources at the end; "likely" = secondary
sources only):

| Where | What applies |
|---|---|
| Netherlands | Peppol is mandatory for invoicing central government (Peppol BIS 3 or SI-UBL 2.0). A cabinet letter of 11 Sep 2026 plans domestic B2B e-invoicing from **1 Jul 2030** (likely; network choice still open). |
| Belgium | B2B Peppol mandate live since **1 Jan 2026**, fines since 1 Apr 2026. Companies register under 0208 (KBO number). Out of scope until there is a BE adapter, but it's the biggest demand driver. |
| Germany | Everyone must receive e-invoices since 2025; issuing from 2027 (turnover above €800k) and 2028 (everyone). Peppol is optional there; XRechnung or ZUGFeRD by email is equally valid. |
| France | Live since 1 Sep 2026, but only through an accredited platform (PA). A plain Peppol access point can't carry domestic French B2B invoices. |
| EU (ViDA) | From **1 Jul 2030** intra-EU B2B invoices must be EN 16931 e-invoices with digital reporting. |

Peppol itself changes too:

- BIS releases come twice a year (May and November).
- Message Level Status (MLS) becomes mandatory between Feb and May 2027.
- Every service provider needs ISO 27001 by 1 Oct 2027.

The last two are the provider's job as long as we use one, which is one more
reason not to run our own access point yet.

## What exists today

- **No Peppol, UBL or EN 16931 code anywhere**, in TypeScript or Rust, and no
  design doc or ADR covers e-invoicing.
- **"Send" doesn't deliver anything.** `PATCH /api/invoices/:id/send`
  (`apps/workers/books-api/src/routes/invoices/index.ts:1121`, Rust in
  `rust/modules/books-sales/src/invoices/actions.rs`) finalizes a draft and
  stamps `sentAt`. The dialog
  (`apps/web/platform/app/weldbooks/invoices/components/send-invoice-dialog.tsx`)
  says the invoice goes to the contact's email, but no email is sent. Peppol
  becomes the first real delivery channel. Email delivery is a separate gap
  (see "Open questions").
- **Inbound documents** land in the accounting documents inbox (`documents`,
  `packages/core/db/src/schema/accounting-documents.ts`). They come from an
  upload, the inbox email address or a mobile scan. OCR fills `ocr_result`, and
  `POST /api/bills/from-document/:documentId` turns that into a bill. **OCR is
  hidden on EU and self-hosted** (`books-ocr` in
  `rust/bins/weldsuite/src/edition.rs`, no AI there, AI-011), so structured
  Peppol bills help those editions most.
- **A provider pattern to copy**: Brazilian fiscal documents go through Focus
  NFe behind `services/br-fiscal` (TS) and `rust/modules/books-tax/src/fiscal/`
  (Rust), with a public webhook mount and re-reading the document from the
  provider instead of trusting the payload (BOOKS-006).
- **Identifiers**:
  - Our side: the entity's numbers are in `legal_entity_registrations`
    (`packages/core/db/src/schema/legal-entities.ts`; types `vat`,
    `company_registration`, …).
  - The customer or supplier: a party (`parties`) points at a company
    (`companies.vat_number`, `companies.registration_number`).
  - Nothing stores a Peppol participant id yet.
- **Tax categories**: the NL adapter
  (`packages/domains/books/src/jurisdictions/nl/tax-categories.ts`) already
  tells `standard`, `reduced`, `zero`, `exempt`, `reverse_charge`,
  `eu_b2b_goods`, `eu_b2b_service` and `export_goods` apart, which is what
  Peppol's VAT category codes need.
- **Edition switches**: `/config.json` lists `unavailableFeatures`, and the
  platform hides them (`apps/web/platform/lib/edition.ts`). `collab-rooms` is
  the example of a feature that is unavailable only when its service isn't
  configured.

## Design

### The port

One interface in each backend, the same operations:

| Operation | What it does |
|---|---|
| `registerParticipant(entity, identifiers)` | Register an entity as a receiver (SMP entries for Invoice and CreditNote), publish its Peppol Directory card |
| `unregisterParticipant(ref)` | Remove it (entity deleted, workspace deleted, moved to another provider) |
| `lookup(participantId)` | Is this participant on Peppol, and can it receive BIS 3 invoices and credit notes? |
| `send(ubl, sender, receiver, documentType)` | Hand a document to the access point; returns the provider's message id |
| `status(messageId)` | Transmission status, including MLS once the provider supports it |
| `fetchReceived(ref)` / `acknowledge(ref)` | Read an inbound document's UBL, mark it as taken |
| `parseWebhook(request)` | Verify and decode the provider's callback |

- TypeScript: `packages/domains/books/src/peppol/` (`@weldsuite/books-domain/peppol`):
  port, UBL builder and parser, mappings, the adapters.
- Rust: `rust/crates/books-domain/src/peppol/`, same split.
- Adapters: the chosen provider; `fake` (records calls, replays fixtures; used
  by the worker tests, the conformance suite and local dev); later
  `own-ap` (phoss AP + phoss SMP), if we ever run our own.

### Provider

**Rules for the EU edition**: EU-owned, EU-hosted, no US cloud in the data
path (the editions design). That rules out:

- ecosio (owned by Vertex, US), Pagero (Thomson Reuters), Basware (Accel-KKR)
  and Tickstar (Xero);
- Storecove and Billit, which run on AWS;
- Banqup for now: its owner is exploring a sale.

**Shortlist for the P0 spike**:

| Provider | Why it's on the list | To check |
|---|---|---|
| e-invoice.be (BE) | JSON or UBL API, HMAC-signed webhooks plus polling, registers customers by API, free sandbox, €0.25 per invoice published | Hosting and sub-processors, NL B2G support, MLS plan |
| Recommand (BE) | Open source (AGPL, like WeldSuite), webhooks, unlimited companies on pooled volume (free to €349/month), playground on the Peppol test network | Hosting, whether it runs its own AS4, NL support |
| eConnect (NL) | Dutch, ISVs run under its certificate, REST and webhooks, strong on Dutch government invoicing | Hosting, pricing, ISV terms |

Criteria for the spike:

- EU hosting, with named sub-processors.
- A DPA.
- An ISV model with one account and many customer legal entities.
- Signed webhooks.
- Receiving.
- SMP migration in both directions, so customers can move to or from us.
- MLS by 2027.
- Dutch government invoicing (OIN 0190, SI-UBL).
- A sandbox on the Peppol test network.
- Pricing.

The pick becomes ADR **BOOKS-009** (Proposed).

**One provider account per edition.** Global, EU and every self-hosted install
have their own account. Nothing is shared at runtime between editions
(OPS-012), and moving a workspace between editions means de-registering in one
and registering in the other. Global uses the same provider as EU unless the
spike finds a reason not to: one adapter, one set of fixtures.

**Self-hosted**: the customer brings their own account with a supported
provider (credentials in the chart values). Without one, Peppol is hidden.
WeldSuite doesn't relay self-hosted traffic.

### Configuration

| Setting | Global (books-api) | Kubernetes (chart) |
|---|---|---|
| `PEPPOL_PROVIDER` (`off` or the adapter name) | var | value |
| `PEPPOL_ENV` (`sandbox` or `production`) | var | value |
| `PEPPOL_API_KEY`, `PEPPOL_WEBHOOK_SECRET` | secrets (`scripts/secrets/manifest.ts`) | Secret |

- When `PEPPOL_PROVIDER` is `off` or unset, the Rust server lists `peppol` in
  `unavailableFeatures`, the way `collab-rooms` works, and the platform hides
  every Peppol surface (`EditionFeature` in `apps/web/platform/lib/edition.ts`).
- On Global the rollout is behind a typed feature flag, `weldbooks-peppol`
  (SEC-008). Run `pnpm rust:catalogs` after adding it.
- Per entity, Peppol is on only when the entity's jurisdiction adapter lists
  the `peppol` feature (BOOKS-003). At launch that's NL only.

### Identifiers

Peppol addresses a party as `scheme:value`.

| Who | Where the id comes from | Schemes |
|---|---|---|
| Our entity (sender and receiver) | `legal_entity_registrations`: `company_registration` (KvK) and `vat`; a new type `nl_oin` for government bodies | 0106 (KvK), 9944 (NL VAT), 0190 (OIN) |
| Customer or supplier | A new `parties.peppol_id`. Empty means "derive": try 0106 from `companies.registration_number`, then 9944 from `companies.vat_number`, through `lookup()` | Any scheme; BE 0208 and 9925, DE 9930 and 0204 are just ids to send to |

- The result of a lookup is cached on the party (`peppol_lookup`: found or
  not, which documents, checked at). It is re-checked when it is older than a
  day and an invoice is about to go out.
- The UI shows the derived id and lets the user type one, for example a
  government body's OIN or a German Leitweg-ID.

### UBL: building and reading

The UBL builder turns a stored invoice or credit note into BIS 3.0 XML. It is
one pure function in each backend, and both must give the same bytes:

| BIS term | From WeldBooks |
|---|---|
| Seller name, address, KvK (BT-30), VAT (BT-31) | The legal entity and its registrations |
| Buyer name, address, VAT, endpoint | The party, its company and its Peppol id |
| Buyer reference (BT-10) | `invoices.reference`. Peppol needs it or an order reference, so the send dialog asks for it when it's empty. For Dutch government it's their order number. |
| Lines | `invoice_items`: quantity, unit (mapped to UNECE Rec 20, default `C62`), net price, discount, line total, the line's period |
| VAT category per line and per rate (BT-118) | From the line's `taxCategoryCode` through a new adapter hook `einvoiceTaxCategory()`: `standard` / `reduced` → S, `zero` → Z, `exempt` → E, `reverse_charge` → AE, `eu_b2b_goods` / `eu_b2b_service` → K, `export_goods` → G, out of scope → O. The exemption reason text comes from the adapter's invoice-format labels. |
| Payment | Code 58 (SEPA credit transfer) with the IBAN of `invoice_bank_account_id`, the invoice number as payment reference, the due date |
| Credit note | UBL `CreditNote` with a `BillingReference` to `credit_note_for_invoice_id` |
| PDF | The invoice's own PDF (`GET /api/invoices/:id/pdf`) embedded as an `AdditionalDocumentReference`. On by default, can be switched off per entity. |
| Currency | When it isn't EUR, the VAT total also goes in EUR (BT-111) at `exchange_rate` |

The parser does the reverse for inbound documents. It fills the same
structured result the OCR produces, so the existing bill-from-document path
works unchanged.

**Validation happens in three places:**

1. **In the builder**, before anything leaves: checks we can explain in plain
   language (no KvK on our entity, no buyer reference, no IBAN, a tax rate
   without a category, a receiver that isn't on Peppol). Messages in en and nl.
2. **In CI**: a job runs the official Schematron artefacts on every golden
   UBL fixture: CEN EN 16931, Peppol BIS 3.0.21, and the Dutch rules for
   Dutch senders. It uses a Java validator in the job only, never at runtime,
   with the artefact versions pinned. Each May and November release is a
   chore with a date.
3. **At the provider**, which validates on submission; its errors become the
   message's failure detail.

**Rounding risk**:

- WeldBooks rounds VAT per line. Peppol checks VAT per rate against the rate
  times the taxable base for that rate.
- Invoices with many lines, discounts or tax-inclusive prices (`taxIncluded`)
  can be a cent off and fail validation.
- P1 proves this with fixtures. If they fail, NL rounding moves to per-rate
  for invoices sent over Peppol. That changes postings, so it is a decision to
  take in P1, not a quiet fix.

### Data model

These are schema changes. The migration needs approval before it is
generated.

Tenant DB:

| Table / column | Purpose |
|---|---|
| `peppol_registrations` | Per entity and identifier: scheme, value, provider, provider ref, status (`pending`, `active`, `failed`, `removed`, `held_elsewhere`), document types, error, timestamps |
| `peppol_messages` | One row per document in or out:<br>• direction and document type (`invoice`, `credit_note`, later `invoice_response`)<br>• links to `invoice_id`, `bill_id` and `document_id`<br>• sender and receiver ids<br>• provider message id (unique per provider) and AS4 message id<br>• status, status detail (jsonb, including MLS)<br>• `file_key` of the exact UBL bytes<br>• attempts and `next_attempt_at`<br>• timestamps |
| `parties.peppol_id`, `parties.peppol_lookup` | The participant id and the cached lookup |
| `accounting_entity_settings.peppol_settings` (jsonb) | Embed the PDF, create draft bills automatically, default channel |

Master DB:

| Table | Purpose |
|---|---|
| `peppol_participant_index` | Participant id (unique) and provider ref → workspace and entity. Routes a webhook to a tenant and stops two workspaces of one edition registering the same KvK. Same pattern as `bank_feed_connection_index`. |

**Files**:

- The UBL is stored as received or sent, never re-generated, under
  `workspaces/<id>/peppol/{out,in}/<message id>.xml` in R2 (Global) or the S3
  store (Kubernetes).
- It is the legal original: keep it at least 7 years for NL, and 10 once BE
  arrives.
- `weldsuite workspace export` and the Global export include these files.

### Sending

1. The send dialog offers **Peppol** when the entity has an active
   registration and the party's lookup says it can receive invoices, and
   **email** otherwise. It shows the receiver id and asks for the buyer
   reference when it's missing.
2. `POST /api/invoices/:id/peppol` finalizes a draft, as `/send` does now. It
   builds and pre-checks the UBL, stores it, writes a `peppol_messages` row
   (`queued`) and calls `send()` with a short timeout.
3. When the provider accepts, the message becomes `sent` and the invoice gets
   `sentAt` and status `sent`, as today. If the provider can't be reached, the
   row stays `queued` and the outbox job retries it with backoff.
4. Webhooks (or the job's polling as a fallback) move the message to
   `delivered` or `rejected` (with the MLS reason) or `failed`. A failure
   notifies the person who sent it and shows on the invoice.
5. Credit notes go the same way, from the credit-note action.

### Receiving

1. The provider calls `/public/peppol-webhooks/<provider>`. The route verifies
   the signature. If the provider doesn't sign, it re-reads the document from
   the provider instead of trusting the payload, as the Focus NFe route does.
   It then finds the tenant through `peppol_participant_index`.
2. The UBL is fetched, stored as received and parsed. It becomes a
   `documents` row with `source = 'peppol'`, status `processed`, the
   structured result filled, and the embedded PDF (if any) as the visible file.
3. **Duplicates**: a second delivery of the same provider message is dropped,
   and the same supplier and invoice number is flagged.
4. **Supplier matching** tries the Peppol id first, then VAT, KvK and IBAN.
   Lines map to the entity's purchase tax rates by VAT category and rate: S
   21% to the high input rate, AE to the reverse-charge purchase rate, K to
   intra-EU acquisition. Anything that doesn't map is left for review.
5. With "create draft bills automatically" on, a draft bill is made through
   the existing bill-from-document path. Otherwise it waits in the inbox like
   any other document.
6. The document gets `acknowledge()`d at the provider.

### The outbox job

A small job every five minutes. It retries `queued` messages, polls statuses
the webhooks missed, and re-checks registrations stuck in `pending`.

- Global: a second cron trigger on books-api (`*/5 * * * *`).
- Kubernetes: `weldsuite cron books-peppol` as a chart CronJob.

A cron rather than a queue keeps both backends the same shape.

### API

Both backends serve the same paths. New path prefixes go into
`packages/core/api-modules/src/index.ts` under `books`, and conformance suites
go into `rust/conformance/suites.json`.

| Route | Permission |
|---|---|
| `GET /api/peppol/registrations`, `POST`, `DELETE /:id` | `settings:read` / `settings:update` |
| `POST /api/peppol/lookup` (`{ partyId }` or `{ participantId }`) | `invoices:read` |
| `GET /api/invoices/:id/ubl` (download, also useful on its own) | `invoices:read` |
| `POST /api/invoices/:id/peppol` | `invoices:update` |
| `GET /api/peppol/messages`, `GET /:id`, `POST /:id/retry` | `invoices:read` / `invoices:update` |
| `POST /public/peppol-webhooks/:provider` | the provider's signature |

Every mutation writes the accounting audit log.

**Entity events**: a new entity type `peppol_message` with actions `sent`,
`delivered`, `failed` and `received`, so a WeldConnect workflow can react to
"a Peppol invoice failed". The invoice keeps its own `sent` event. These
events carry ids and statuses, never the UBL.

### Platform

- **WeldBooks → Settings → Peppol**: registration per entity, status of each
  identifier, the "registered elsewhere" case with instructions to move it,
  and the settings toggles.
- **Send dialog**: channel choice, receiver id, buyer reference.
- **Invoice panel**: a Peppol status line and the message history, with retry.
- **Party and company detail**: the Peppol id field with a "check" button.
- **Documents inbox**: a Peppol badge, the parsed lines next to the PDF.
- **A Peppol messages list** under WeldBooks for the log.
- Every new string in en and nl. Help docs under `apps/web/docs` with
  screenshots once the UI settles.
- The mobile app (`weldbooks-app`) shows the status read-only; sending from
  mobile comes later.

## Phases

Each phase lands in TypeScript and Rust in the same PR, with its tests and
conformance suites.

| Phase | Work | Done when |
|---|---|---|
| **P0 Provider** | Sandbox accounts with the shortlist, a send and a receive on the Peppol test network with each, the criteria above checked, ADR BOOKS-009 written, contract and DPA. Schema approved. | One provider picked, ADR Proposed, migration approved |
| **P1 UBL** | Builder and parser in both backends, the tax-category hook in the NL adapter, unit and payment mappings, about 25 golden fixtures (domestic, reverse charge, ICP, export, credit note, foreign currency, discounts, tax-inclusive prices, many lines), the CI Schematron job, `GET /api/invoices/:id/ubl` | Every fixture passes the official artefacts, both backends produce the same bytes, rounding question answered |
| **P2 Port and registration** | Port, provider adapter and `fake` adapter, migration, master index, settings page, party lookup, the `peppol` edition feature, the webhook route | An NL entity registers in the provider's sandbox from Global test and from the EU test cluster |
| **P3 Sending** | Send dialog, outbox and job, status handling, invoice panel, failure notifications, entity events | Invoices and credit notes reach a test receiver on the Peppol test network, with statuses tracked in both editions |
| **P4 Receiving** | Webhook to inbox, parser into bills, supplier and tax matching, embedded PDF, automatic draft bills, duplicates | Test invoices sent from another access point arrive as draft bills in both editions |
| **P5 Production** | Production accounts per edition, secrets manifest, chart values, Secret and CronJob, flag rollout on Global, help docs, a Peppol round trip in the monthly EU drill | First live invoice sent and received on Global and on the EU test cluster |

## Testing

- **Golden UBL fixtures** live in `packages/domains/books/src/peppol/__fixtures__/`
  and are read by both test suites, the way the payroll vectors are, so the
  bytes can't drift apart.
- **The CI Schematron job** pins the BIS and CEN artefact versions and fails
  on any error. It also runs a set of real-world inbound samples through the
  parser.
- **The `fake` adapter** backs the worker tests (pglite) and the conformance
  runs. Side effects are compared there: the message row, the stored file, the
  provider calls.
- **A provider sandbox round trip** runs in the nightly job and the monthly
  EU drill, not on every PR.

## Risks

- **Rounding and tax-inclusive prices** fail Peppol's arithmetic rules. Found
  in P1, fixed before anything is sent.
- **Provider lock-in**: receivers stay registered at the provider. Choose one
  that supports SMP migration both ways, and keep everything behind the port.
- **Provider sovereignty can change**: an acquisition can move a provider
  out of the EU rules (it happened to ecosio, Pagero and Basware). Put a
  change-of-control clause in the contract, and keep the port clean enough
  that switching takes weeks, not months.
- **Two backends, one byte stream**: shared fixtures and the conformance
  suite are the guard.
- **BIS releases twice a year**: the CI artefacts and the mappings need a look
  each May and November. Put it on the calendar.
- **Retention against deletion**: deleting a workspace removes its UBL files,
  which the law wants kept for 7 to 10 years. The customer's export includes
  them. The deletion flow should say so, and de-register the participants
  first (`workspace-deletion` in both backends).
- **Cost on EU**: billing is off there (no Mollie yet), so documents cost us
  money without a charge until pricing exists. Count every message from day
  one.

## Open questions

1. **The provider**: decided in P0 from the shortlist.
2. **Pricing**: included in WeldBooks, per document from credits on Global,
   or an add-on? EU has no billing yet either way.
3. **Draft bills by default**: should received invoices become draft bills
   automatically, or wait in the inbox until someone acts?
4. **Email delivery**: "Send" doesn't email anything today. Build server-side
   email delivery, with the PDF and the UBL attached, as the fallback channel
   for receivers who aren't on Peppol? That is its own piece of work, but the
   send dialog changes in P3 either way.
5. **Government customers**: support sending to Dutch government bodies
   (OIN, their order number as buyer reference) from P3, or after launch?

## Docs to update

- **New ADR BOOKS-009**: Peppol through an EU access-point provider behind a
  port, in every edition. Proposed in P0, Accepted when P3 lands.
- `design/modules/weldbooks.md`: the architecture, flows, tables and API
  sections.
- `design/platform/editions-and-self-hosting.md`: a row in the ports table
  ("E-invoicing: EU access-point provider; the customer's own account on
  self-host").
- The status doc: `peppol` when unconfigured.
- `rust/modules/books/PORTING.md`: the new crate area.

## Later (separate plans)

- **Belgium**: a BE jurisdiction adapter (BTW/TVA rates, KBO, Intervat
  returns), then Peppol with 0208 registration. The mandate is live, so this
  is the obvious next country.
- **Germany**: a DE adapter, XRechnung (the CIUS) and Leitweg-ID (0204) for
  government; ZUGFeRD by email as the non-Peppol channel.
- **Invoice Response** (accept, reject, paid) back to suppliers when a bill is
  approved, rejected or paid. Opt-in in Peppol, not required in NL or BE.
- **Our own access point**: phoss AP and phoss SMP (Java, Apache-2.0) as a
  sidecar on Kubernetes, like collab-rooms. It needs OpenPeppol membership
  (from €2,750 a year plus sign-up and certification for AP and SMP), a
  contract with the Dutch Peppol Authority, ISO 27001, monthly statistics
  reports and MLS. Worth it only at volume, or to offer Peppol to self-hosted
  installs.
- **France**: only through a PA partner.
- **Peppol ordering** (BIS Ordering) for WeldCommerce B2B orders.
- **NL B2B mandate (2030) and ViDA (2030)**: revisit once the NL bill names a
  network and a reporting channel.

## Sources

Checked 2026-11-11 unless dated.

- Peppol BIS Billing 3.0 release notes: https://docs.peppol.eu/poacc/billing/3.0/release-notes/
- MLS phase-in (2026-07-02): https://docs.peppol.eu/edelivery/changelog/2026-07/Peppol%20MLS%20Phase-In%201.0.0%202026-07-02.pdf
- ISO 27001 for service providers (2026-06-25): https://openpeppol.atlassian.net/wiki/spaces/Security/pages/5232230408/ISO+IEC+27001
- OpenPeppol fees: https://peppol.org/join/fees/
- Dutch Peppol Authority, becoming a service provider: https://www.peppolautoriteit.nl/aanmelden-als-serviceprovider
- NL validation artefacts mandatory 17 Aug 2026 (2026-05-31): https://www.vatupdate.com/2026/05/31/may-2026-npa-validation-artefacts-for-si-ubl-2-nlcius-and-peppol-bis-3-mandatory-from-17-august-2026/
- NL B2B plans (2026-09-11): https://www.peppol.nu/en/blog-items/preparing-for-mandatory-e-invoicing-netherlands/
- Belgium: https://einvoice.belgium.be/en and Deloitte (2026-03-31): https://www.deloitte.com/be/en/services/tax/blogs/e-invoicing-in-belgium-end-of-the-grace-period-and-full-enforcement-of-the-mandate-now-in-effect.html
- Germany, Peppol for government: https://e-rechnung-bund.de/en/transmission-methods/peppol
- ViDA timeline: https://econnect.eu/en/docs/knowledge/regulations/europe/vida/timeline
- Open-source AP/SMP: https://github.com/phax/phoss-ap, https://github.com/phax/phoss-smp
- Providers: https://e-invoice.be/peppol-api, https://recommand.eu/en/pricing, https://econnect.eu/en/partners/why-econnect, https://www.storecove.com/nl/en/security, https://www.billit.eu/en-int/about-us/compliance-trust/
- Acquisitions: Vertex–ecosio (2024-08-07) https://www.vertexinc.com/company/news/latest-news/vertex-acquires-ecosio-accelerate-global-e-invoicing-compliance, Thomson Reuters–Pagero (2024-02-26) https://www.cpapracticeadvisor.com/2024/02/26/thomson-reuters-acquires-pagero-for-800-million/101999/
