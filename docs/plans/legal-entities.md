# Legal entities: one company record for WeldBooks, WeldHR and later apps

Status (11 October 2026): **plan, nothing built.** The owner's decisions from
11 October are in the first table. Migrations listed here still need the
owner's go-ahead before they are generated (CLAUDE.md rule).

## Decisions

| Question | Decision |
|---|---|
| Who owns legal entities | **The core platform** (app-api, Settings → Legal entities). Each app keeps its own extension rows per entity. WeldHR works without WeldBooks installed. |
| UI name | **Legal entities** / **Juridische entiteiten**. Inside an app the local word may stay: WeldBooks "Administrations", WeldHR "Employer". |
| Workspace business profile (Settings → Business) | **Becomes the default legal entity.** One source of truth; `workspace_settings` legal fields are migrated into it and later dropped. |
| Bank accounts | **Move to the legal entity.** The account itself (holder, IBAN, account number, payment-file settings) is core and shared by WeldBooks and WeldHR. Bank feeds, reconciliation, the ledger link and check printing stay WeldBooks features on top of it. |
| Employees | **Every WeldHR employee has an employing legal entity**, not only employees on payroll. |
| Access per entity | **Later phase, designed for now.** v1 keeps workspace-wide permissions but routes every entity lookup through one resolver where the check will go. |
| Other apps (Commerce, CRM quotes, WeldStash, …) | **Contract only.** This plan wires WeldBooks and WeldHR and documents how a later app attaches. |

## Where we are today

The same company is stored three times, in three shapes:

1. **WeldBooks `entities`** (`packages/core/db/src/schema/accounting-entities.ts`).
   Identity, tax ids (plain `tax_identifiers` jsonb), plain `bank_details`,
   branding, lock dates, US tax classification, sales-tax engine credentials,
   SSN. About 45 accounting tables carry `entity_id` (plain `varchar(30)`, no
   foreign keys, like the rest of the schema). Also referenced by
   `settings.default_entity_id`, `audit_log.accounting_entity_id`,
   `payroll_imports.entity_id` and the master `bank_feed_connection_index`.
2. **WeldHR `hr_payroll_employers`** (`weldhr-payroll.ts:322`). Its own name,
   legal name, country, currency and address; the loonheffingennummer, EIN and
   state account numbers in plain jsonb; the salary account as an encrypted
   blob (`bank_encrypted`). An optional `accounting_entity_id` points at
   WeldBooks; when it is null, approved pay runs skip the journal silently
   (`journal.ts:75`).
3. **`workspace_settings`** (`workspace-settings.ts`). Legal name, trading
   name, contact, address, VAT and registration number, logo, colors. Edited
   in Settings → Business, mirrored to the Stripe customer, read by the
   booking portal and the HR portal emails.

Problems this causes or hides:

- **books-api never validates the entity header.** `resolveEntityId`
  (`books-api/src/lib/entity-context.ts:13`) takes `X-Accounting-Entity-Id`,
  `?entityId` or the default, and 35 files trust the result. A soft-deleted or
  unknown id goes straight into queries. (Tenant DBs keep this inside one
  workspace, so it is an integrity bug, not a cross-tenant leak.)
- **The default entity is inconsistent.** Create never clears `is_default` on
  others, PATCH does not sync `settings.default_entity_id`, DELETE does not
  clear it. Commerce (`order-sales-tax.ts:235`) and WeldConnect guess with
  three fallbacks.
- **DELETE of an entity does not check for data** (`accounting-entities/index.ts:847`).
- **The client's current entity is not scoped to the workspace**
  (`atomWithStorage('weldsuite.currentAccountingEntityId')`); switching
  workspace keeps a foreign id. The mobile app already scopes it per org.
- **Bank details exist in four places**: `entities.bank_details` (plain,
  printed on invoices), `bank_accounts` (IBAN plain, account number
  encrypted, NACHA `ach_settings`), `hr_payroll_employers.bank_encrypted`
  (with its own `nachaCompanyId`), and nothing in workspace settings.
- **Name collisions**: `entity_id` is also the polymorphic column on files,
  notifications, custom-field values, search index, audit logs; the
  permission object `entities` exists in WeldBooks and WeldConnect;
  `entities.entity_type` is the US legal form.

Other readers of `entities` today, which must keep working: commerce-api
(order sales tax, portal invoices), connect-api and `@weldsuite/connect-domain`
(connector entity checks and default fallback), external-api
(`GET /v1/accounting-entities`, read-only), the books sweep cron, the
WeldBooks mobile app ("administrations"), hr-api (employer link).

## Target model

**Rule for what is core:** a fact about the company that is true whichever app
looks at it (name, legal form, country, address, registrations, bank
accounts, fiscal year) is core. How one app works with the company (lock
dates, sales-tax engine, payroll rates, ledger links) is that app's extension.

```
                      ┌──────────────────────────────────────┐
                      │ entities  (core: the legal entity)   │
                      │ legal_entity_registrations (core)    │
                      │ bank_accounts              (core)    │
                      └──────────────────────────────────────┘
                           ▲                      ▲
   WeldBooks extension     │                      │     WeldHR extension
   accounting_entity_settings (1:1)               hr_payroll_employers (N:1,
   accounting_bank_account_settings (1:1)           one per payroll registration)
   ~45 tables keep entity_id                      hr_employees.legal_entity_id
```

### Table names stay

The physical tables `entities` and `bank_accounts` keep their names and ids.
Every `entity_id` in WeldBooks stays valid, nothing is rewritten, and old
workers keep reading the same table during the deploy window. The Drizzle
definitions move to a new core file
`packages/core/db/src/schema/legal-entities.ts` and export `legalEntities` and
`bankAccounts`; `entities` stays as a deprecated alias export so existing
imports compile. New apps name their column `legal_entity_id`; WeldBooks keeps
`entity_id`. A table rename can come later behind a view; it buys nothing now.

### `entities`: the core legal entity

| Column | Fate |
|---|---|
| `id`, timestamps, `deleted_at` | core |
| `name` (display), `legal_name`, `dba` (trading name) | core |
| `entity_type` → meaning becomes "legal form", catalog per country (NL bv, nv, eenmanszaak, vof, stichting…; US llc, c_corp, partnership, sole_proprietorship…; IN private_limited, llp…) | core |
| `jurisdiction_code` (country of registration), `base_currency`, `locale`, `timezone` | core |
| `address` (shared `PostalAddress` plus optional `houseNumber` / `houseNumberAddition`, which the loonaangifte needs) | core |
| `contact` (email, phone, website, plus `contactPerson` from workspace settings) | core |
| `branding.logoUrl`, `primaryColor`, `accentColor` | core |
| `fiscal_year_start`, `fiscal_year_config`, `tax_classification` (US) | core |
| `is_default`, `is_active` | core; partial unique index: one default where `deleted_at IS NULL` |
| `tax_identifiers` | → `legal_entity_registrations` |
| `bank_details` | → a core `bank_accounts` row, referenced by WeldBooks as the invoice account |
| `branding.footerText`, `paymentInstructions`, `termsAndConditions` | → `accounting_entity_settings.document_texts` |
| five lock dates, `accounting_method`, `sales_tax_engine`, `sales_tax_engine_config`, `sales_tax_credentials_encrypted`, `ssn_encrypted`, `ssn_last4`, `jurisdiction_settings` (KOR, IN state code) | → `accounting_entity_settings` |

### `legal_entity_registrations` (new, core)

Every number an authority gave the company, in one list:

```
id ('ler'), entity_id, type, country, region (US/IN state), number,
label ("L01 DGA"), valid_from, valid_to, is_primary, verified_at,
verification (jsonb, e.g. a VIES result), timestamps, deleted_at
index (entity_id, type)
```

Types in v1: `vat`, `company_registration` (KvK, Companies House, CIN), `rsin`,
`ein`, `gstin`, `pan`, `eori`, `nl_payroll_tax` (loonheffingennummer, several
per entity allowed: L01, L02), `us_state_withholding`, `us_state_unemployment`,
`other`. Format validators per type live with the Zod schemas in
`@weldsuite/app-api-client/schemas/legal-entities` so client and server agree
(VAT reuses the rules in `@weldsuite/books-domain` `vies.ts`). Sales-tax
permits stay on WeldBooks' `sales_tax_agencies` for now (follow-up). The SSN of
a sole proprietor stays encrypted on the WeldBooks extension, because only
WeldBooks uses it.

### `bank_accounts`: core bank accounts

| Column | Fate |
|---|---|
| `id`, `entity_id`, `name`, `account_holder_name`, `iban`, `bic`, `bank_name`, `currency`, `account_type`, `routing_number`, `account_number_encrypted`, `account_number_last4`, `is_default`, `is_active`, timestamps | core |
| `ach_settings` (NACHA immediate origin, company id) | core: WeldBooks payment runs and WeldHR payroll both build NACHA files from it, replacing HR's `nachaCompanyId` |
| `ledger_account_id`, `current_balance`, `last_import_date`, `last_import_balance`, `auto_reconcile`, `feed_*` (6 columns), `next_check_number`, `check_settings`, `positive_pay_format`, `import_settings`, `metadata` | → `accounting_bank_account_settings` |

A core account without a WeldBooks settings row is simply not in WeldBooks
(for example an HR-only workspace's salary account). WeldBooks' bank page gets
"Add an existing account of this entity", which asks for the ledger account.
Bank connections, feed transactions, imports and reconciliations keep their
`entity_id` and `bank_account_id` and stay WeldBooks-only.

Sensitive data: the full account number stays encrypted with the existing
keyring (`DATABASE_ENCRYPTION_KEY`, `packages/core/db/src/lib/crypto.ts`), and
is returned masked. Revealing it needs `legal_entities:reveal` and is logged
in a small core table `legal_entity_reveals` (who, what, when). Building a
payment file decrypts on the server under the app's own permission
(`payroll:approve`, WeldBooks payment runs), as today; the user never sees the
number.

### WeldBooks extension tables (new)

- **`accounting_entity_settings`** (PK `entity_id`): the columns moved out of
  `entities` (above) plus `invoice_bank_account_id` and `document_texts`.
  Its existence means "WeldBooks is enabled for this entity".
- **`accounting_bank_account_settings`** (PK `bank_account_id`, plus
  `entity_id`): the WeldBooks columns moved out of `bank_accounts`.
- `settings.default_entity_id` is deprecated: WeldBooks opens the user's
  current entity, else the core default if WeldBooks is enabled for it, else
  the first enabled entity.

### WeldHR

- **`hr_payroll_employers` becomes a payroll registration under a legal
  entity** (N:1, because a Dutch BV can have several loonheffingennummers):
  - add `legal_entity_id` (NOT NULL after backfill), `registration_id` (the
    core `nl_payroll_tax` or `ein` registration), `bank_account_id` (core
    account salaries are paid from), `label` (was `name`, optional);
  - keep `nl_settings` (minus `loonheffingennummer`), `us_settings` (minus
    `ein` and the per-state account numbers; rates stay),
    `require_separate_approver`, `is_active`, and the employer ids that
    schedules, profiles, runs, payslips and filings already reference;
  - drop at contract: `name`, `legal_name`, `country`, `currency`, `address`,
    `accounting_entity_id`, `bank_encrypted`.
  - Country and currency come from the legal entity, so a mismatch with the
    ledger can no longer happen (`assertAccountingEntity` goes away).
- **`hr_employees.legal_entity_id`**: the employing entity. A payroll profile
  must use an employer registration of that same entity.
- `@weldsuite/payroll-domain` does not change. hr-api gets one loader,
  `loadEmployerForPayroll(db, employerId)`, that merges entity, registration,
  bank account and settings into the shapes the engines already take
  (`types.ts`, `us/forms.ts` `UsEmployerForForms`, `nl/loonaangifte.ts`,
  `payslip-pdf.ts`). Every service that reads the employer row today
  (`calculate`, `payslips`, `files`, `filings`, `annual`, `journal`,
  `schedules`, `employees`, `overview`, `approve`, self-service) goes through it.

## Core service and API

**`@weldsuite/core-domain/legal-entities`** (`packages/domains/core`), imported
by app-api, books-api, hr-api, commerce-api and connect-api:

- `listLegalEntities`, `getLegalEntity`, `getDefaultLegalEntity`,
  `createLegalEntity`, `updateLegalEntity`, `setDefaultLegalEntity`,
  `archiveLegalEntity`, `deleteLegalEntity`;
- registrations and bank accounts: list, create, update, delete,
  `revealBankAccountNumber`, `getRegistration(entityId, type, region?)`;
- `legalEntityContext({ app?, required })`, a Hono middleware: resolves
  `X-Legal-Entity-Id`, then `X-Accounting-Entity-Id` (kept forever for old
  mobile binaries), then `?entityId`, then the default; checks the entity
  exists, is not deleted, and (when `app` is given) is enabled for that app;
  sets `c.get('legalEntity')`. **This is the one place the per-entity access
  check goes later.**
- an extension registry, `LEGAL_ENTITY_EXTENSIONS`: per app a label, an
  `isEnabled(db, id)` probe and a `hasData(db, id)` probe. It powers the
  "Used by" panel and blocks deletes. Reading other modules' tables through
  `@weldsuite/db` for such lookups is allowed by the module-split rules.
- The Stripe customer mirror moves here from
  `app-api/src/services/workspace-settings.ts`: updating the default entity
  mirrors its name and address.

Archive (`is_active = false`) is always allowed except for the default; it
hides the entity from pickers and blocks new postings and pay runs. Delete
(soft) is refused while any extension reports data. The default cannot be
archived or deleted until another entity is made default.

**app-api routes** (`apps/workers/app-api/src/routes/legal-entities/`; prefix
`/api/legal-entities` registered as core in `packages/core/api-modules`):

| Method and path | Permission |
|---|---|
| `GET /api/legal-entities`, `GET /:id`, `GET /default`, `GET /:id/usage` | `legal_entities:read` |
| `POST /`, `PATCH /:id`, `POST /:id/make-default`, `POST /:id/archive`, `DELETE /:id` | `legal_entities:create` / `update` / `delete` |
| `GET\|POST\|PATCH\|DELETE /:id/registrations[/:regId]` | read / update |
| `GET\|POST\|PATCH\|DELETE /:id/bank-accounts[/:accountId]` | read / update |
| `POST /:id/bank-accounts/:accountId/reveal` | `legal_entities:reveal` |

Zod v3 schemas and the domain client go in `@weldsuite/app-api-client`
(`schemas/legal-entities.ts`, `domains/legal-entities.ts`); the stale
`core-api-client/src/schemas/accounting-entities.ts` is replaced.
`X-Legal-Entity-Id` is added to the CORS allow-list in
`packages/core/worker-kit/src/cors.ts`. external-api gets read-only
`GET /v1/legal-entities` (scope `legal_entities`, masked bank data);
`/v1/accounting-entities` keeps its shape.

**Permissions** (`packages/core/permissions`): a workspace-level object
`legal_entities` (registered in no app, like `team` and `roles`):

| Key | Default | Backfilled to roles that hold |
|---|---|---|
| `legal_entities:read` | everyone | (default) |
| `legal_entities:create`, `:update`, `:delete` | OWNER, ADMIN | WeldBooks `entities:create\|update\|delete`, `payroll:manage`, `general:update` (Business page) |
| `legal_entities:reveal` | OWNER, ADMIN | `tax_ids:reveal` |
| `legal_entities:manage` | OWNER, ADMIN | reserved for the access phase |

WeldBooks' `entities:*` object stays (stored grants keep their keys) and is
relabelled "Administrations (WeldBooks settings per entity)": enabling
WeldBooks for an entity and editing its WeldBooks settings. Creating a new
entity from inside WeldBooks or WeldHR needs `legal_entities:create` as well.

**Entity events** (`packages/core/entity-events/src/events/`): new
`legal_entity` (created, updated, archived, deleted; registrations count as an
update) and `legal_entity_bank_account` (created, updated, deleted; ids and
masked numbers only). `accounting_entity` stays for the WeldBooks extension.
The new app-api mutation routes join `_event-coverage.test.ts`. Reveals are
logged in `legal_entity_reveals`, not sent as events.

## How each app uses it

### WeldBooks

- `@weldsuite/books-domain` gets `loadAccountingEntity(db, id)`, which returns
  core entity + registrations + extension merged into today's `Entity` shape,
  and `loadBooksBankAccount`. The jurisdiction adapters
  (`jurisdictions/{nl,us,in}`), `accounting-compliance.ts`,
  `accounting-invoice-html.ts`, `accounting-guards.ts` and `sales-tax/load.ts`
  take the merged object and do not change.
- `resolveEntityId` becomes a wrapper over `legalEntityContext({ app: 'weldbooks' })`.
  Unknown, deleted or not-enabled ids answer 404 instead of reaching queries.
- `/api/accounting-entities` keeps its paths and response shape (the mobile
  app and external-api depend on it):
  - `GET` lists entities with WeldBooks enabled, merged;
  - `POST` with `legalEntityId` enables WeldBooks for an existing entity
    (seeds sequences, chart of accounts, tax rates as today); without it,
    creates the core entity and the extension in one transaction (same tenant DB);
  - `PATCH` splits the write between core and extension;
  - `DELETE` removes only the WeldBooks extension, and is refused once
    WeldBooks has postings. Archiving the company is done in Settings.
- Bank account routes read and write through the core service plus the
  extension. Invoices print the account `invoice_bank_account_id` points at.
- Other readers switch to the books-domain loader: commerce-api
  `resolveOrderTaxEntity` and `commerce-portal-invoices`, connect-api
  `accountingEntityExists` and the ingest fallback, the books sweep cron,
  external-api's read-only routes.

### WeldHR

- Employer setup: pick a legal entity (or create one inline), then pick or
  add its payroll registration and its salary bank account. The dialog stops
  asking for name, country, currency and address.
- Journal posting (`journal.ts`): `entityId = employer.legal_entity_id`.
  When WeldBooks is not enabled for that entity, `journalStatus = 'skipped'`
  with reason `books_not_enabled`, and the run screen says so with a link to
  enable it. No more silent skip.
- Employees: an "Employer" field (legal entity picker, defaulting to the
  default entity) on the employee form; lists can filter by entity. Portal
  emails and the hr-portal use the employing entity's name and logo.

### Workspace business profile

- Settings → Business (`app/settings/business/page.tsx`,
  `general/business-settings-form.tsx`) edits the default legal entity through
  `/api/legal-entities/default`. With no entity yet, the form shows the
  `workspace_settings` values and creates the default entity on first save
  (country and currency required).
- During the transition, `PUT /api/workspace-settings` writes the legal fields
  through to the default entity, and `GET` reads them back from it, so old
  clients keep working. Theme, timezone, language, date formats and
  `custom_settings` stay on `workspace_settings`.
- Readers move to the default entity: the booking portal
  (`booking-portal/lib/booking-server.ts`), the hr-api portal mail, the plan
  pricing country, the Stripe mirror.

## Contract for later apps

An app that needs "which of our companies" (a Commerce store's seller, the
issuer of a CRM quote, a warehouse's importer of record with its EORI):

1. **Reference, never copy.** Store `legal_entity_id varchar(30)`. Read
   identity, registrations and bank accounts through
   `@weldsuite/core-domain/legal-entities`.
2. **Snapshot what you issue.** A document sent to a third party (invoice,
   quote, payslip, filing, customs declaration) stores a snapshot of the
   issuer's identity when it is finalised, so later edits do not rewrite
   history.
3. **Per-app settings go in an extension table** keyed by the entity
   (`<app>_legal_entity_settings`, 1:1), or N:1 rows like the HR payroll
   registrations. Never add app columns to `entities`.
4. **Register the extension** in `LEGAL_ENTITY_EXTENSIONS` with `isEnabled`
   and `hasData`, so "Used by" and delete protection work.
5. **Resolve the current entity with `legalEntityContext({ app })`**, never by
   reading a header yourself. This is how per-entity access will reach the app
   without changes.
6. **Default for the app**: when the app has no selection, use the core
   default if it is enabled for the app, else ask. No three-step guessing.
7. **UI**: use the shared `LegalEntityPicker` / `LegalEntitySwitcher` and
   the per-workspace current-entity atom (below).

Commerce, CRM quotes and WeldStash follow this when they are built; this plan
only changes their existing reads (Commerce) to the loader.

## Platform UI

- **Settings → Legal entities** (core settings section): list with default
  badge, country, currency and "Used by" chips; detail tabs General,
  Registrations, Bank accounts, Used by; archive and make-default actions.
  Settings → Business becomes the edit page of the default entity.
- **Shared components** in `apps/web/platform/components/legal-entity/`:
  `LegalEntityPicker`, `LegalEntitySwitcher`, `RegistrationList`,
  `BankAccountForm` (IBAN or routing + account, masked display, reveal).
- **Current entity**: one `currentLegalEntityIdAtom` stored under
  `weldsuite.currentLegalEntityId:<workspaceId>`, shared by WeldBooks and
  WeldHR. This fixes the unscoped key. `useCurrentAccountingEntity` wraps it
  and falls back to a WeldBooks-enabled entity.
- **WeldBooks** "Administrations" pages (`app/weldbooks/entities/`): list =
  enabled entities; "Add administration" = pick an existing legal entity or
  create one; the edit page shows core fields read-only with a link to
  Settings and edits only WeldBooks settings (KOR, lock dates, sales tax,
  document texts, invoice bank account). `entity-switcher.tsx` and
  `create-entity-dialog.tsx` move onto the shared components.
- **WeldHR**: payroll settings list registrations grouped by legal entity;
  `employer-dialog.tsx` and `employer-bank-dialog.tsx` are rebuilt on the
  pickers; the employee form gets the employer field.
- **Mobile** (`weldbooks-app`): no change in v1, `/api/accounting-entities`
  keeps its shape and the app already sends the old header.
- **i18n**: every new string in `en/` and `nl/` (`settings.ts` for the core
  settings, `accounting.ts`, `weldhr-payroll.ts`, `weldhr-people.ts`). The
  help guide `apps/web/docs/src/app/weldbooks/us/setup` covers entity setup;
  its text and screenshots are updated with the new add-administration flow.

## Per-entity access (later phase, designed now)

- Entities are open by default. `legal_entities:manage` can mark an entity
  **restricted** and give members access to it:
  `legal_entity_members (entity_id, user_id, granted_by, created_at)`, the
  same shape as `weldpass_vault_members` without roles. App permissions still
  decide what a member may do inside the entity.
- Enforcement in two places only: `legalEntityContext()` (404 for an entity
  the member cannot see) and `listLegalEntities({ forUserId })`. Because v1
  sends every WeldBooks and WeldHR request through the middleware, the phase
  adds no per-route work.
- Owners and `legal_entities:manage` see all. WeldHR employee lists filter by
  employing entity; external-api keys get an optional entity allow-list.

## Migration and rollout

Deploys run migrations before workers (`deploy.yml`), so release 1 is
**additive only** and old workers keep working on the old columns. Release 2
drops them.

### Release 1 (expand)

One tenant migration, generated with `pnpm --filter @weldsuite/db db:generate`,
plus a custom data migration (`drizzle-kit generate --custom`, journaled):

- Schema: create `legal_entity_registrations`, `legal_entity_reveals`,
  `accounting_entity_settings`, `accounting_bank_account_settings`; add the new
  `hr_payroll_employers` columns and `hr_employees.legal_entity_id`; add the
  partial unique index for the default entity.
- Data, in SQL (deterministic copies, safe to re-run):
  1. Fix duplicate defaults before the index: keep `settings.default_entity_id`,
     else the oldest default, clear the rest.
  2. One `accounting_entity_settings` row per `entities` row; one
     `accounting_bank_account_settings` row per `bank_accounts` row.
  3. Registrations from `entities.tax_identifiers` (`vatNumber` → `vat`, or
     `gstin` for IN; `registrationNumber` → `company_registration`;
     `einOrSsn` in EIN format → `ein`; ambiguous 9-digit values go to the
     script report).
  4. HR employers: `legal_entity_id = accounting_entity_id` when it points at a
     live entity; otherwise insert a new `entities` row from the employer's
     own name, country, currency and address. Copy the loonheffingennummer,
     EIN and state account numbers into registrations (reuse an equal one on
     the entity; a different EIN is kept as non-primary and reported) and set
     `registration_id`. Two employers on one entity are fine (N:1).
  5. `hr_employees.legal_entity_id` from the payroll profile's employer, else
     the default entity when one exists.

A TypeScript backfill in `apps/tools/migrate-databases`
(`backfill-legal-entities.ts`, `--dry-run` / `--execute`, the
`rotate-encryption-key.ts` pattern, needs the encryption keys) does what SQL
cannot:

- decrypt each `hr_payroll_employers.bank_encrypted`, match it to a core bank
  account on the entity (IBAN, or routing + decrypted account number), else
  create one; move `nachaCompanyId` into `ach_settings`; set `bank_account_id`;
- turn `entities.bank_details` into a core bank account (matched the same
  way) and set `invoice_bank_account_id`;
- merge `workspace_settings` into the default entity: an existing WeldBooks
  default wins field by field, empty fields are filled from workspace settings,
  differences are listed; with no entity, create the default only when the
  country normalises to ISO-2 (otherwise it is created on the next save of the
  Business page);
- fill the remaining `hr_employees.legal_entity_id` from the new defaults;
- print a per-workspace report: conflicts, ambiguous SSN/EIN values,
  unmatched bank accounts. Run it on test, review, then production.

Compatibility during release 1:

- New code reads the new tables and **also writes the old columns** (mirror),
  so rolling workers back to the previous release stays safe.
- Until the script has run for a workspace, hr-api falls back to
  `bank_encrypted` and invoices fall back to `bank_details`.

### Release 2 (contract)

After release 1 has run in production and the script reports clean
everywhere: stop mirroring and drop the moved columns from `entities`,
`bank_accounts` and `hr_payroll_employers`, the legal fields from
`workspace_settings`, and `settings.default_entity_id`. The old
`X-Accounting-Entity-Id` header stays accepted.

## Delivery

| PR | Contents |
|---|---|
| 1 | Release 1: schema and migrations, core-domain service and middleware, app-api routes, permissions and events, WeldBooks and WeldHR on the core, business profile, platform UI, external-api read route, backfill script, tests |
| 2 | Release 2: the contract migration and removal of the mirrors and fallbacks |
| later | Per-entity access; the follow-ups below |

PR 1 is large, in line with how WeldBooks US and payroll shipped. It can be cut
into core / WeldBooks / WeldHR / UI if review prefers, as long as everything
before release 2 stays additive.

## Tests

- core-domain: service tests on the pglite harness (`@weldsuite/worker-kit`
  test kit): default uniqueness, archive and delete rules, extension registry,
  reveal logging, middleware (header precedence, deleted, not enabled).
- books-api: a contract test that `GET /api/accounting-entities` and
  `GET /api/accounting-entities/:id` return the same JSON before and after the
  migration for fixture entities (NL, US, IN); NL BTW, US sales-tax and IN GST
  returns built from the merged loader equal today's output.
- hr-api: for a fixture NL and US employer, the loonaangifte XML, the SEPA and
  NACHA files and the 941/W-2 figures are byte-equal before and after the
  migration; journal posting with WeldBooks enabled and not enabled.
- Migration: the SQL backfill on pglite with fixture rows (duplicate defaults,
  unlinked employer, employer linked to a deleted entity, two employers on one
  entity); the script in dry-run against the same fixtures.
- Existing guards: `tenant-schema-drift.test.ts`, the api-modules ownership
  test, app-api `_event-coverage.test.ts`, permission catalog tests.
- Platform: switcher scoping per workspace; Business page round-trip.

## Risks

- **Old mobile binaries and API users** rely on `/api/accounting-entities`,
  `/v1/accounting-entities` and the old header. All three keep their shape;
  the contract test above guards it.
- **Workspace profile and WeldBooks entity disagree** (different address or
  VAT number). The merge keeps the WeldBooks values and reports the rest; the
  report is reviewed before `--execute` on production.
- **Regenerated documents.** WeldBooks invoices render the entity live, and
  HR filings, annual statements and payment files read the live employer.
  The migration copies values one-to-one, so nothing changes by itself, but an
  edit after the move changes regenerated documents exactly as it does today.
  The snapshot rule (contract item 2) is the fix; see follow-ups.
- **Permissions.** Members who can create a WeldBooks administration or a
  payroll employer today must keep that; the role backfill covers it and is
  part of release 1.
- **Encryption.** The script needs `DATABASE_ENCRYPTION_KEY` and `_V2`; the
  core bank account uses the same keyring as today, so there is no re-keying.

## Follow-ups (not in this plan)

- Issuer snapshots on WeldBooks invoices and HR filings at finalisation.
- Sales-tax permits from `sales_tax_agencies` into core registrations.
- The sole proprietor's SSN into core registrations, if another app needs it.
- VIES / KvK lookups that fill and verify registrations.
- Commerce seller entity per store or portal, CRM quote issuer, WeldStash
  importer of record (EORI), WeldMail campaign footer address, all through the
  contract.
- The WeldBooks mobile app on the core API (pick an existing legal entity).
- MCP tools for legal entities.
