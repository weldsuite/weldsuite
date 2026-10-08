# WeldBooks: United States accounting

Status (8 October 2026): phase 0 (ledger foundations) is built — see "Phase 0:
what was built" below; phases 1 and later are not started. The research behind it (US
federal rules, sales and use tax, QuickBooks Online, Odoo, bank-feed
aggregators, with sources) is in
[weldbooks-us-research/](weldbooks-us-research/README.md), which starts with a
short summary of the US rules.

WeldBooks supports two jurisdictions today, the Netherlands and India, through
the `JurisdictionAdapter` in `packages/domains/books/src/jurisdictions/`. This
plan adds the United States as the third. The US is not another VAT country. It
has no VAT and no federal sales tax, and buyers never reclaim the sales tax they
pay. Instead it has sales and use tax run by 45 states, DC and thousands of
local jurisdictions, federal information returns (1099s), and a banking system
built on routing numbers, ACH and checks. Most of the work is new capability,
not new tax rates.

## Decisions taken with the product owner

- **Audience**: US-based small businesses first (sole proprietors, LLCs,
  partnerships, S and C corporations keeping their full books in WeldBooks).
  Tools for sellers who sell into the US from elsewhere (nexus monitoring,
  multi-state returns) come after, on the same foundation.
- **Sales tax rates**: a pluggable engine. A manual engine (rates the user
  maintains, enough for a business collecting in one or two states) and
  provider engines that call a rate API for address-accurate rates in every
  state.
- **Filing**: WeldBooks prepares, the user files. Per-agency sales tax return
  worksheets with payment recording; 1099s as recipient PDFs plus an IRS-ready
  file the user uploads to IRIS. E-filing can come later.
- **First US release includes bank feeds.** Checks, ACH (NACHA) payment files,
  sales tax at WeldCommerce checkout, and fixed assets with MACRS depreciation
  come in later phases.
- **Bank feeds are a provider-neutral package** (`@weldsuite/bank-feeds`), so
  WeldSuite can switch aggregators (if Plaid doesn't approve us) or run several
  side by side to cover more banks. Plaid and Stripe Financial Connections are
  both candidates for the first adapter; see section 9.

Defaults assumed in this plan (say so if any is wrong):

- **Payroll is out of scope.** US payroll stays in Gusto, ADP and the like;
  WeldBooks imports the payroll journal in a later phase.
- **Tax-engine credentials are the customer's own** (bring your own key).
  WeldSuite doesn't resell a tax engine in v1.
- **Schema changes ship with drizzle-kit migrations**, generated per PR and
  approved per PR (the CLAUDE.md rule).
- **Delivery**: phased PRs against `develop`, behind a `weldbooks-us` feature
  flag until the first release is complete.

## How the US differs from what WeldBooks models today

| Concept | NL / IN today | US |
|---|---|---|
| Tax type | VAT / GST, charged at every stage, input tax reclaimed | Sales tax on the sale to the final consumer; buyers never reclaim it |
| Tax on purchases | Input VAT, a receivable | Part of the cost of what was bought (expense or asset). If the vendor charged none, the buyer self-assesses use tax |
| Who sets the rate | One national table (21% / 9% / 0%; GST slabs) | State + county + city + special districts, by ship-to address (destination states) or seller location (origin states); rates change quarterly |
| When to charge | Always, once registered | Only in states where the seller has nexus and is registered |
| Exemptions | Buyer's VAT status (reverse charge), export | Buyer's exemption certificate (resale, nonprofit, government ...) per state, and product taxability per state |
| Return | One per country per period | One per state agency (some local agencies too), each with its own frequency and due date |
| Tax IDs | VAT number, KvK, GSTIN, PAN | EIN for businesses, SSN/ITIN for individuals, a sales tax permit per state |
| Information returns | ICP (NL) | 1099-NEC / 1099-MISC for contractors and other payees |
| Banking | IBAN/BIC, SEPA, CAMT.053/MT940 | Routing + account number, ACH, checks, OFX/BAI2, aggregator feeds |
| Reporting basis | Accrual | Cash or accrual (most small businesses file on cash basis), plus a trial balance mapped to the income tax return |

## Where WeldBooks stands (code read, 7 October 2026)

Read on `develop` @ `212d4b7a`. The gaps that block a US release:

**Ledger**
- Only invoice finalize, bank categorize, manual journal entries and FX
  differences post journal entries. Approving a bill, recording a payment and
  reconciling a bank line to an invoice or bill change status only
  (`books-api/src/routes/bills/index.ts` approve, `routes/payments/index.ts`,
  `routes/invoices/index.ts` record-payment).
- Invoice postings credit one revenue account for the whole subtotal (the
  per-line account is ignored), and journal lines carry no `taxRateId`,
  `taxAmount` or currency (`invoices/index.ts` L861-1023, `buildJournalLine`
  L171-185). The VAT return reads journal lines, so **invoice tax never reaches
  the NL VAT return today**.
- Journal headers and lines are written in two statements without
  `atomically()` (TASK-639): `invoices/index.ts:939/979`,
  `journal-entries/index.ts:168/201/331/366`,
  `services/accounting-bank-categorize.ts:148/166`.
- Credit notes post with the wrong sign; recurring invoices compute no tax and
  `autoFinalize` skips posting.
- A payment points at one invoice or one bill (`payments.invoiceId` /
  `billId`), so one check paying five bills can't be recorded.
- books-api has no cron triggers: nothing marks invoices overdue, generates
  recurring invoices or refreshes FX rates.

**Tax**
- The adapter is only used for seeding (chart of accounts, tax rates, numbering,
  invoice labels). `resolveTaxRate`, `buildTaxReturn` and
  `validateTaxIdentifier` are only called from tests; the client picks a rate
  per line and three forms each compute tax inline.
- One tax rate per line, stored as `numeric(5,2)` (8.875% can't be stored), no
  effective dates, no geography.
- VAT returns are Dutch rubrieken end to end (`vat_returns`,
  `routes/vat-returns`, `app/weldbooks/vat`); IN entities see the NL screen.
- `products.taxable` / `taxClass` and `parties.taxExempt` exist and nothing
  reads them.

**Parties and addresses**
- Three address shapes: Dutch-style `{street, houseNumber, postalCode, city,
  province}` on entities and invoices; `{line1, line2, city, state, postalCode}`
  on parties, companies and orders; flat columns on suppliers. Invoices have no
  ship-to address, bills none at all. No US state list exists in the repo.
- The contact form has no address section (TASK-691), and the contacts route
  drops tax number, email, phone, payment terms and notes.
- No TIN, W-9 or 1099 fields anywhere.

**Banking**
- Bank accounts are IBAN/BIC only (DB, forms, PDF, dashboard, reconciliation by
  counterparty IBAN). Parsers: MT940, CAMT.053 and Dutch-bank CSV; the CSV
  parser reads every N/N/YYYY date as day-month and "1,234" as 1.234. No feeds.

**UI and formatting**
- Only NL and IN can be chosen. Entity types lack LLC, S corp, C corp and
  partnership. There is no entity edit page, so the address, bank details and
  the existing `einOrSsn` field can't be set.
- EUR / `nl-NL` fallbacks, hard-coded `nl-NL` dates, "today" computed in UTC, an
  A4 PDF with a "VAT:" prefix, Dutch terms in the English bundle.
- Reports have no cash/accrual basis (`settings.accountingMethod` exists and
  nothing reads it), and the P&L defaults to 1 January whatever
  `fiscalYearStart` says.

**Other surfaces**
- external-api's generic accounting CRUD (`routes/v1/accounting/crud-routes.ts`,
  removed in phase 0) wrote invoices straight into the tables: no tax
  calculation, no posting, NL/EUR defaults.

The bottom line: before WeldBooks can keep a US company's books, every document
has to post to the ledger. That work also fixes problems Dutch users have
today, so it is phase 0 of this plan rather than a US-only cost.

## Target design

### 1. US jurisdiction adapter

`packages/domains/books/src/jurisdictions/us/`:

| File | Contents |
|---|---|
| `index.ts` | The adapter: code `US`, locale `en-US`, currency `USD` |
| `entity-types.ts` | Sole proprietorship, single-member LLC, multi-member LLC, partnership, S corp, C corp, nonprofit; LLC tax classification (disregarded, partnership, S corp, C corp) and the federal return each files (Schedule C, 1065, 1120-S, 1120, 990) |
| `chart-of-accounts.ts` | One base chart in US numbering (1000 assets, 2000 liabilities, 3000 equity, 4000 income, 5000 cost of goods sold, 6000-7000 expenses, 8000-9000 other) plus an equity section per entity type: owner's capital and draws (sole proprietor), a capital account per partner (partnership), stock, paid-in capital, retained earnings and distributions (S corp, which also tracks its accumulated adjustments account), stock, paid-in capital, retained earnings and dividends (C corp), net assets with and without donor restrictions (nonprofit) |
| `tax-lines.ts` | Line catalogs for Schedule C (Part II lines 8–27b, Part III, Part V), 1065, 1120-S and 1120 page 1, versioned per tax year (Schedule C lines 27a/27b swapped for 2025), plus M-1 codes for non-deductible items; the default line for every seeded account |
| `states.ts` | USPS code, name, FIPS code, has sales tax, intrastate sourcing (origin in AZ, CA for state/county/city only, IL, MS, MO, OH, TN, TX, UT, VA; destination elsewhere, including NM and, from October 2026, PA local tax), SST member, agency name and portal, rounding mode, cash-basis reporting allowed, default due day, vendor-discount rule, special programs (Alabama's flat 8% remote-seller program, Texas's single local use rate election). Due dates and vendor discounts are verified against each state's revenue department before they ship |
| `identifiers.ts` | EIN (`XX-XXXXXXX`, valid prefixes kept as data), SSN (rejects area 000/666/900–999, group 00, serial 0000), ITIN (`9XX-XX-XXXX` with the IRS's middle-digit ranges), ABA routing checksum (weights 3-7-1, sum ≡ 0 mod 10), ZIP and ZIP+4 stored as text |
| `nexus-thresholds.ts` | Economic nexus rules per state, versioned by effective date: sales threshold, transaction test (none, OR, AND), what counts (gross, retail or taxable sales), measurement window (previous/current calendar year, rolling 12 months, rolling four quarters, Connecticut's October–September year), whether marketplace sales count, and when collection must start. Seeded from the table in `weldbooks-us-research/sales-tax.md` §2.3 |
| `form-1099.ts` | Forms, boxes and thresholds per tax year |
| `tax-codes.ts` | WeldBooks product tax codes and their mapping to each provider's codes |
| `invoice-format.ts` | Labels and requirements: Letter paper, MM/DD/YYYY, "Sales tax", bill-to and ship-to, terms |

Changes to the adapter contract (`jurisdictions/types.ts`):

- **`features`**: which jurisdiction modules exist (`vatReturn`, `icp`, `xaf`,
  `smallBusinessScheme`, `salesTax`, `form1099`). Routes, navigation and pages
  gate on these instead of `jurisdictionCode === 'NL'`.
- **`terminology`**: label overrides the UI reads (VAT number → EIN, supplier →
  vendor, credit note → credit memo, VAT → sales tax).
- **`requiredFields`** widened to include `einOrSsn`.
- **`SystemAccountRole`** gains `undeposited_funds`, `sales_tax_payable`,
  `use_tax_payable`, `owner_equity`, `owner_draws`, `opening_balance_equity`
  and `credit_card_payable`.
- **An async `calculateTax(request)`** replaces the never-used `resolveTaxRate`
  in the request flow. NL and IN implement it with today's per-line logic; US
  delegates to the entity's sales tax engine.

### 2. One tax calculation path for every jurisdiction

books-api gets one `calculateDocumentTax(entity, document)`, called whenever an
invoice, credit memo, bill, recurring template or order-to-invoice conversion is
created or changed. The forms show what the server returns; the three inline
calculations in `invoice-form.tsx`, `invoice-dialog.tsx` and `bill-form.tsx`
go away (as does the dead `lib/tax-utils.ts`).

The result keeps the existing `taxBreakdown` shape, extended with jurisdiction
detail: `jurisdictionCode`, `jurisdictionLevel` (state, county, city,
district), `stateCode`, `agencyId`, `taxableAmount`, `exemptAmount`,
`nonTaxableAmount`, `exemptReason`, `certificateId`. India's CGST/SGST/IGST
split fits the same shape, so `expandGstTaxBreakdown` becomes one
implementation of it instead of an `if (IN)` branch.

Rates move to `numeric(7,4)` everywhere a rate is stored.

### 3. Sales tax engine

`packages/domains/books/src/sales-tax/`, in the domain package so commerce-api
can use the same engine for checkout later.

```ts
interface SalesTaxEngine {
  readonly id: 'manual' | 'stripe_tax' | 'avalara' | string;
  calculate(req: SalesTaxRequest): Promise<SalesTaxResult>;
  /** Record a finalized document with the provider (provider engines only). */
  commit?(result: SalesTaxResult, documentNumber: string): Promise<void>;
  /** Credit memo or void against a committed document. */
  reverse?(ref: string, lines: ReverseLine[]): Promise<void>;
  validateAddress?(address: PostalAddress): Promise<AddressValidation>;
}

interface SalesTaxRequest {
  entityId: string;
  documentType: 'invoice' | 'credit_memo' | 'bill' | 'estimate' | 'order';
  documentDate: string;            // tax point, YYYY-MM-DD
  shipFrom: PostalAddress;         // entity location or warehouse
  shipTo: PostalAddress;           // falls back to bill-to
  customer: { partyId: string; certificates: ExemptionCertificateRef[] };
  lines: Array<{
    lineId: string;
    amount: number;                // net of seller discounts
    quantity: number;
    taxCode: string;               // WeldBooks product tax code
    use: 'business' | 'personal';  // customer default, overridable per line
    taxIncluded?: boolean;
  }>;
}

interface SalesTaxResult {
  engine: string;
  engineRef?: string;              // provider calculation / transaction id
  lines: Array<{
    lineId: string;
    taxableAmount: number;
    exemptAmount: number;
    nonTaxableAmount: number;
    tax: number;
    details: Array<{
      jurisdictionCode: string;    // FIPS / SST code where available
      jurisdictionName: string;
      level: 'state' | 'county' | 'city' | 'district';
      stateCode: string;
      agencyId?: string;
      rate: number;
      taxableAmount: number;
      tax: number;
      exemptReason?: string;
      certificateId?: string;
    }>;
  }>;
  warnings: Array<'not_registered_in_state' | 'address_unverified' | 'no_ship_to' | string>;
}
```

Rules shared by every engine:

- **Collect only where registered.** Tax is charged when the entity has an
  active registration for the ship-to state (or, for origin-sourced intrastate
  sales, the seller's state). Elsewhere the line is untaxed with a
  `not_registered_in_state` note, which feeds nexus tracking.
- **An address is required.** A taxable US invoice can't be finalized without a
  ship-to (or bill-to) state and ZIP.
- **Exempt customers.** A valid certificate covering the ship-to state on the
  document date zeroes the tax and records the reason and certificate. The sale
  still counts as gross and exempt sales on the return.
- **Posted tax is frozen.** Drafts recalculate; finalized documents never do,
  whatever happens to rates later. Credit memos reverse the original
  document's tax lines.
- **Overrides stick.** A user can override the tax on a line (with a reason);
  the override is stored and survives later edits of the draft. QuickBooks
  drops overrides on every edit and users complain about it.
- **Ship-from is per document**, defaulting to the entity address, so a business
  with several locations (or WeldStash warehouses later) gets the right origin
  rate in origin-sourced states.
- **Rounding** follows the Streamlined Sales Tax rule by default: compute to
  three decimals, round half-up to the cent, per jurisdiction at document
  level, remainder on the last line. Line-level vs invoice-level and
  per-jurisdiction vs combined are per-state settings in `us/states.ts`,
  because a few states differ. Unrounded and rounded tax are both stored so
  returns reconcile.
- **Rates are picked by the tax point** (the invoice date by default), never by
  today's date, so back-dated invoices and credit memos use the rate that
  applied. A credit memo reuses its original invoice's jurisdictions and rates.
- **Shipping** is a line with tax code `shipping` (and `handling` where a state
  treats them differently), so per-state shipping taxability is handled like
  any other product.
- **Business or personal use** is a customer default with a per-line override:
  some states tax SaaS only for business buyers (Ohio) or only for consumers
  (Iowa), or at different rates (Maryland 3% vs 6%).
- **Tax-inclusive lines** are allowed (the tax is backed out of the price) but
  the invoice always prints the tax amount, which is what states that permit
  inclusive pricing require.
- **An engine failure never posts zero tax.** If the provider is unreachable,
  the draft keeps its last calculation and finalizing is blocked with a clear
  error.

Engines:

- **Manual.** For a business collecting in one or two states. The user defines
  jurisdictions (state, county, city, district) with dated rates, and combines
  them into "tax zones": a combined rate plus the ZIP codes or ZIP ranges it
  applies to, or the entity's own location for origin-sourced sales. Per
  agency, the user sets which WeldBooks tax codes are taxable, with effective
  dates (California and Colorado start taxing SaaS on 1 January 2027) and an
  optional taxable percentage (Texas taxes SaaS on 80% of the price). A ship-to
  outside every zone falls back to the state rate with an `address_unverified`
  warning. The UI says plainly that this engine is the user's responsibility
  and doesn't fit multi-state sellers. Later, a "look up this rate" helper can
  fill zones from free official sources: the Streamlined Sales Tax rate and
  boundary files (24 states, quarterly), Washington's and California's address
  APIs, Texas's rate files.
- **Provider.** Calls a rate API with the full request and stores the
  provider's per-jurisdiction answer. Credentials are the customer's own,
  stored encrypted per entity.
  - **First provider: Stripe Tax**, through its calculations API. It works
    without Stripe payments, returns a per-jurisdiction breakdown, and costs
    the customer $0.05 per calculation. WeldBooks builds returns from its own
    `tax_lines`, so it doesn't need Stripe's transaction records ($0.50 per
    transaction); `commit` is only used when the customer also lets Stripe
    file for them. Stripe Tax only calculates where the customer has
    configured a registration in Stripe, so setup checks that Stripe's
    registrations match WeldBooks' agencies.
  - **Second provider: Avalara AvaTax**, for mid-market customers who already
    have an account, and for customers who want free filing through a
    Streamlined Sales Tax Certified Service Provider (Avalara, TaxCloud and
    Sovos are CSPs; the SST states pay their fees for most remote sellers).
  - TaxJar, Anrok, Numeral, Kintsugi and Zip-Tax all fit the same interface if
    customers ask for them.

### 4. Tax ledger

A new table, `tax_lines`, written in the same `atomically()` batch as the
journal entry when a document posts. One row per document line per
jurisdiction:

`entity_id, source_type (invoice | credit_memo | bill | journal | adjustment),
source_id, source_line_id, journal_entry_id, tax_date, direction (sales |
purchase | use), jurisdiction_code, jurisdiction_level, state_code, agency_id,
tax_rate_id, tax_category_code, rate, gross_amount, taxable_amount,
exempt_amount, non_taxable_amount, tax_amount, exempt_reason, certificate_id,
ship_to_state, ship_to_postal_code, engine, engine_ref, tax_return_id,
currency, base_currency_tax_amount`

Rows are immutable. A credit memo writes negative rows, and a return sets
`tax_return_id` on the rows it includes, so a filed period can't change under
it. Every tax report and return, the NL VAT return included, reads this table
instead of journal lines. That fixes the missing invoice tax on the Dutch
return as a side effect.

### 5. Agencies, registrations and returns

**`sales_tax_agencies`** (one row per state, plus self-administered local
agencies such as Colorado home-rule cities): `entity_id, state_code, level
(state | local), name, registration_number, registered_from, registered_until,
status (registered | pending | monitoring | closed), filing_frequency (monthly |
quarterly | semiannual | annual), first_period_start, due_day, reporting_basis
(accrual | cash, where the state allows it), sst_member, liability_account_id,
portal_url, notes`.

Registering an agency creates its child account under Sales Tax Payable (2200
"Sales Tax Payable – Texas Comptroller"), so the balance sheet shows what is
owed per agency.

**Returns**: a generic `tax_returns` table replaces the Dutch-only
`vat_returns` for new jurisdictions (NL keeps its own until it is moved over):
`entity_id, jurisdiction_code, agency_id, period_start, period_end, due_date,
status (open | calculated | reviewed | filed | paid), summary jsonb, lines
jsonb, filed_at, confirmation_number, payment_id, adjustments jsonb,
amends_return_id`.

The adapter's `buildTaxReturn` produces the US worksheet from `tax_lines`, per
agency and period:

- gross sales shipped into the state, then deductions by reason: resale,
  nonprofit, government, interstate, exempt products, non-taxable services,
  exempt freight, returns and allowances, bad debts written off, and
  marketplace-facilitated sales where the return asks for them; then taxable
  sales;
- tax by reporting location (county, city, district or the state's location
  code), since many states want local tax broken out;
- use tax due from purchases;
- adjustments: vendor discount (timely-filing allowance), prepayment credit,
  penalty, interest, rounding, other. Each has its own account (discount to
  other income, penalty and interest to expense).

Sales Tax Center flow: list of agencies with what's due and when → open a
period → run the pre-file check → review the worksheet (drill down to
documents) → mark filed with the confirmation number → record the payment
(debit the agency's payable, credit the bank, post adjustments).

- **Pre-file check**: compares the period's net sales on the return with income
  on the P&L and lists the documents behind any difference (income posted
  without tax data, sales to the state with no ship-to, journal entries that
  hit the payable account directly). QuickBooks ships this as an AI agent; a
  plain query does the job.
- **Liability check**: the agency's GL balance against the unfiled `tax_lines`,
  with the differences listed.
- **Changes to a filed period** (a late credit memo, a voided invoice) never
  edit the filed return. They show as exceptions on the period, and the user
  either files an amended return for it or carries the difference into the
  next return. QuickBooks only offers the carry-forward.

Due dates come from the agency's frequency and due day. A daily books-api cron
sends reminders through `@weldsuite/notifications`.

### 6. Exemption certificates and product tax codes

**`exemption_certificates`**: `entity_id, party_id, states text[], reason
(resale | nonprofit | government | manufacturing | agricultural | other),
certificate_number, form (sst_f0003 | mtc_uniform | state_form | other),
issued_on, expires_on, blanket (bool), document_id (R2 via the existing
documents table), status (valid | expired | pending), notes`. The customer page
gets an "Exemptions" tab, the invoice prints the exemption reason and
certificate number, and a report lists certificates expiring in the next 60
days.

Validity rules differ per state (Florida's annual resale certificate expires
every 31 December; Washington reseller permits last 48 months; an SST blanket
certificate stays valid while purchases are no more than 12 months apart), so
expiry comes from the certificate where it has one and from a per-state rule
otherwise. Under SST, a seller is protected if it gets a complete certificate
within 90 days of the sale: an exempt sale without a valid certificate is
flagged on a "missing certificates" report with its cure deadline, and counts
as taxable on the worksheet once the deadline passes.

A bad-debt write-off of an invoice that carried tax creates negative
`tax_lines`, so the next return takes the bad-debt deduction per jurisdiction.

**Product tax codes**: a short WeldBooks list (`general`, `saas`,
`digital_goods`, `services`, `professional_services`, `shipping`,
`food_grocery`, `prepared_food`, `clothing`, `prescription_drugs`,
`non_taxable`) mapped to each provider's own codes in `us/tax-codes.ts`.
Products store it in the existing `products.tax_class` column; invoice and bill
lines get a `tax_code` column so ad-hoc lines can carry one too.

### 7. Purchases and use tax

- Sales tax a vendor charges is part of the cost. US bills post the tax into the
  line's expense or asset account, never to a tax receivable. The adapter
  decides this, so NL and IN keep posting input tax as they do today.
- Use tax (later phase): a bill line can be marked "accrue use tax". The engine
  computes the rate at the delivery address, and posting debits the
  expense/asset and credits "Use Tax Payable – agency". The amount flows into
  that agency's return as use tax due.

### 8. 1099 reporting

**Vendor data** (on `parties`, behind a "Tax reporting" section of the vendor
form):

- `is_1099_vendor`, `default_1099_form` (`nec` | `misc`), `default_1099_box`;
- `tin_type` (`ein` | `ssn` | `itin`) and the TIN itself, stored encrypted in a
  `sensitive_encrypted` blob following the WeldHR pattern
  (`packages/core/db/src/schema/weldhr.ts`, `hr-api/src/services/weldhr/employees.ts`);
- W-9 fields: legal name (line 1), business name (line 2), federal tax
  classification, exempt payee code, FATCA code, W-9 received date and the
  scanned W-9 (documents table);
- `backup_withholding` flag, and `tin_last4` in plain text for display.

**Account mapping**: each expense account can carry a default 1099 box (Contract
labor → NEC 1, Rent → MISC 1, Royalties → MISC 2, Legal fees → NEC 1, ...),
or "omit". A bill line can override the box, so a mixed-use account doesn't
have to be split (QuickBooks allows one box per account only). The US chart
seeds sensible defaults.

**Yearly computation** (cash basis, calendar year):

- Payments made in the year to 1099 vendors, allocated over the paid bills'
  lines and mapped to boxes through the line's account (or the vendor
  default), plus bank lines categorized directly to a 1099 vendor.
- Payments by credit card, debit card or a third-party network (PayPal and the
  like) are excluded, because those payees get a 1099-K from the processor.
  The exclusion reads the payment-method enum below or a payment from a
  credit-card account, never keywords in the reference (QuickBooks greps the
  check-number field for "Visa", "PayPal" and the like).
- Thresholds are data per tax year and box in `us/form-1099.ts`: $600 for
  payments made in 2025; for payments made in 2026, $2,000 for NEC box 1 and
  MISC rents, other income and medical payments (One Big Beautiful Bill Act,
  Rev. Proc. 2025-32), indexed for inflation from 2027. Royalties stay at $10
  and attorney gross proceeds (MISC 10) at $600. "$2,000 or more", so exactly
  $2,000 is reported. 1099-K went back to more than $20,000 and more than 200
  transactions.
- Payments run through a payroll provider (Gusto and the like pay contractors
  too) are left out, since the provider files those 1099s.
- Year-end review screen: vendors over the threshold, vendors missing a TIN or
  address, corporations that don't need a form (except attorneys), manual
  adjustments with a reason.

**Outputs**:

- Recipient copies as PDF (Copy B; Copy 2 where states need it) with the
  recipient's TIN truncated to the last four digits, and the payer copy.
- **IRIS upload files.** The IRS's old FIRE system closes on 19 November 2026;
  tax year 2026 forms (due 1 February 2027, since 31 January is a Sunday) go
  through IRIS. The free IRIS Taxpayer Portal accepts CSV uploads of up to 100
  records per file, one form type per file, in the IRS's own template (column
  headers are validated). WeldBooks generates those files, split per 100. IRIS
  A2A (XML, its own TCC, IRS ATS testing each year) is the later e-file route
  if we become a transmitter; nothing gets built for FIRE.
- State copies: most states take the data through the IRS's Combined
  Federal/State Filing program when the form is filed with the state code; a
  per-state table in `us/form-1099.ts` flags states that need direct filing.
- Corrected forms for changes after filing.
- Delivery by print, or electronically after the recipient's affirmative
  consent (the IRS requires specific disclosures first, and the form must stay
  available through 15 October).

**Backup withholding**: when a vendor has no TIN (or the IRS reports a wrong
one), 24% is withheld from payments: the payment posts the withheld amount to
a "Backup withholding payable" account, it shows in box 4, and a report feeds
Form 945.

**Security**: TINs never appear in entity events, logs, list endpoints or
exports other than the 1099 files. Revealing a full TIN needs a separate
permission and every reveal is recorded in an append-only table, the way WeldHR
handles `employees:sensitive`.

### 9. Bank feeds and US banking

**Package**: `packages/core/bank-feeds` (`@weldsuite/bank-feeds`), modelled on
`@weldsuite/connectors` (one folder per provider, a factory, webhook helpers, a
sync due-index).

```ts
interface BankFeedProvider {
  readonly id: 'plaid' | 'stripe_fc' | 'teller' | 'ponto' | 'enable_banking' | string;
  readonly capabilities: {
    regions: string[];               // ['US'], ['NL', 'BE', ...]
    changeCursor: boolean;           // true: server-side change feed (Plaid); false: date-range polling
    webhooks: boolean;
    pendingTransactions: boolean;
    maxHistoryDays: number;          // Plaid 730, Stripe FC 180, PSD2 ~90-730
    onDemandRefresh: boolean;
    consentTtlDays?: number;         // PSD2: 180 (90 at some banks)
    accountTypes: Array<'depository' | 'credit' | 'loan'>;
  };
  createLinkSession(input: {
    workspaceId: string;
    mode: 'create' | 'reauth' | 'add_accounts';
    connectionId?: string;
    historyDays: number;
    redirectUrl: string;
  }): Promise<{ kind: 'plaid_link' | 'stripe_fc' | 'redirect'; token?: string; clientSecret?: string; url?: string }>;
  completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }>;
  syncTransactions(connection: StoredConnection, cursor: unknown): Promise<{
    upserts: FeedTransaction[];
    removals: string[];              // provider transaction ids
    nextCursor: unknown;             // opaque, stored as JSON per provider
    hasMore: boolean;
  }>;
  getBalances(connection: StoredConnection): Promise<FeedBalance[]>;
  refresh?(connection: StoredConnection): Promise<void>;
  parseWebhook(request: Request, secrets: ProviderSecrets): Promise<FeedEvent[]>;
  disconnect(connection: StoredConnection): Promise<void>; // always calls the provider's revoke/remove
}
```

Normalization rules the package owns, so WeldBooks never sees provider quirks:

- **Amounts** are integers in minor units, signed from the account holder's side
  like a bank statement: money in positive, money out negative (a card purchase
  is negative). Plaid sends decimals with outflows positive and is negated;
  Stripe FC already uses the statement convention.
- **Dates** become calendar dates without time-zone conversion (Plaid sends
  local `YYYY-MM-DD`, Stripe FC a unix timestamp).
- **Pending vs posted**: pending transactions show in the feed but never become
  reconcilable `bank_transactions`. Plaid issues a new id when a transaction
  posts (linked through `pending_transaction_id`); Stripe FC changes the status
  in place; date-range providers are matched on amount, a 10-day window and
  description, and unmatched pending rows are voided after 14 days.
- **Dedupe**: unique on (bank account, provider, provider transaction id). A
  secondary fingerprint (account fingerprint, date, amount, normalized
  description, occurrence) only flags likely duplicates after a relink or a
  provider switch.
- **Date-range providers** (everyone except Plaid and, partly, Stripe FC) are
  re-pulled over a 7–10 day window, because dates and amounts move when a
  transaction posts.
- **Account fingerprint** (institution + mask + subtype, or the provider's
  persistent account id) so a relink or a switch to another provider reattaches
  to the same WeldBooks bank account.
- **Connection status** is one enum: `active | reauth_required | expiring |
  revoked | disconnected | error`. Stripe FC tracks status per account rather
  than per connection, so the package keeps it per account and rolls it up.
- **Persist everything**: after a Stripe FC disconnect the provider's data is no
  longer readable, and accounting records must be kept for years anyway.
- **Syncs are idempotent queue jobs**, deduplicated per connection, because
  webhooks arrive at least once and out of order.
- **Webhook verification** differs per provider: HMAC (Stripe, Teller), an ES256
  JWT with key fetch (Plaid, key cached in KV), mTLS or signed requests on our
  outbound calls (Teller, Ponto, Enable Banking, via Workers mTLS bindings).

Several providers at once: each connection records its provider. Which
providers are offered is set per environment and per country through Flagship
feature flags, so switching the US default is config, not code. A later
"search your bank" box can query every enabled provider's institution list and
route each bank to the provider that covers it.

Where it runs:

- books-api: link sessions, completing links, mapping feed accounts to
  WeldBooks bank accounts, the sync itself (it owns the tenant DB and the
  books services).
- `integration-webhook-worker`: receives provider webhooks, verifies them,
  looks the connection up in a master-DB index (`provider + connection id →
  workspace`), and asks books-api to sync over a service binding.
- `integration-sync-worker`: a due-index sweep (the pattern it already uses for
  CRM connections) for connections without webhooks and as a daily safety net.
- Platform: one `ConnectBankButton` with a small launcher per provider (Plaid
  Link, Stripe.js `collectFinancialConnectionsAccounts`, redirect flows), all
  returning the same callback payload to books-api.

Data: `bank_connections` (`entity_id, provider, provider_connection_id,
institution_id, institution_name, status, credentials_encrypted, sync_cursor,
last_synced_at, last_error, consent_expires_at, created_by`) and on
`bank_accounts`: `feed_connection_id, feed_account_id, feed_sync_from`. Access
tokens are encrypted with `encryptField`.

**Which provider first** (research, 7 October 2026):

| | Stripe Financial Connections | Plaid |
|---|---|---|
| Access | FC registration on the existing Stripe account. Stripe's pages conflict on whether a non-US Stripe account may use FC data products: confirm for WeldSuite's Stripe entity | Production application, security questionnaire; reportedly Custom (sales-led) plans only for Europe-based customers |
| Price | ~$/€0.30 per institution per customer per month for transactions, published | ~$0.30 per connection per month (unpublished), possible minimums on Custom plans |
| History on first link | Up to 180 days | Up to 730 days (must be requested at link time) |
| Refresh | Daily, plus rate-limited on-demand refresh | 1–4 times a day, plus paid refresh |
| Data | Amount, description, status; no merchant, category or check number | Merchant, category, counterparty, check number |
| Credit cards / business accounts | Supported in the data model; issuer coverage (Amex, Chase, Citi, Capital One) undocumented | Cards including Amex; business accounts at ~95% of SMB banks |
| Fit with our stack | Already in the repo: raw-fetch Stripe client, a `cus_` per workspace as account holder, HMAC webhooks | New vendor; raw fetch (its SDK uses axios), ES256 webhook JWTs |

Plaid is the stronger bank feed for accounting (two years of backfill, more
frequent refresh, richer data, what Xero US, Wave and Odoo use). Stripe
Financial Connections is the faster one to go live with. The plan:

1. **Start both applications now**, they cost nothing to start: Stripe FC
   registration (Dashboard → Settings → Financial Connections) with a written
   question to Stripe about eligibility for WeldSuite's Stripe entity, and the
   Plaid production application (with a quote if WeldSuite contracts from the
   Dutch entity).
2. **Stripe FC first if, within about two weeks**, Stripe confirms live
   transaction access for our account and a live test links a credit card at
   Amex, Chase, Capital One and Citi plus a business checking account.
   Otherwise Plaid first. The other one becomes the second adapter and the
   fallback for banks the first can't link.
3. **If FC is used, consider a separate Stripe account for it.** Today one
   Stripe account bills every WeldSuite subscription; a restriction on it
   would stop billing and every customer's bank feed at once.
4. **Teller** is a cheap third US option (US only, self-serve, mTLS works with
   a Workers mTLS binding). MX, Finicity and Yodlee are sales-led; Quiltt
   bundles several of them if coverage gaps show up.
5. **Europe** (phase 8): Ponto (Isabel) for the Dutch and Belgian customers,
   the usual choice in Benelux accounting tools, with a customer-paying price
   model; Enable Banking for the rest of the EU. GoCardless Bank Account Data
   has closed new signups.
6. **File import stays** as the fallback and for history beyond what a feed
   gives (Stripe FC's 180 days won't reach 1 January for a customer who starts
   in October).

CFPB §1033 (the US open-banking rule) is stayed by a court and being rewritten,
and business accounts appear to be outside it anyway, so it doesn't change the
choice: coverage depends on each aggregator's own bank agreements, and per-pull
bank fees (JPMorgan already charges aggregators) may reach provider prices.

**Other US banking** (first release unless noted):

- Bank accounts get `routing_number` (ABA checksum), `account_number` (stored
  encrypted, last four shown), `account_type` (checking, savings, credit card,
  money market, line of credit). Credit cards are bank accounts backed by a
  liability account.
- Statement import adds OFX/QFX/QBO, and the CSV parser takes an explicit date
  order, thousands separator and negative style (`(123.45)`, separate
  debit/credit columns) instead of guessing day-month.
- Reconciliation gets a statement-based flow (statement end date and balance,
  tick cleared items, finish with a reconciliation report), which US
  bookkeepers expect, next to today's match suggestions. Matching by
  counterparty name and amount replaces IBAN-only matching.
- Payment methods become an enum: `check, ach, wire, credit_card, debit_card,
  cash, third_party_network, bank_transfer, direct_debit, ideal, other`, with
  `check_number` on payments.
- `payment_allocations` lets one payment cover several invoices or bills.
  Received payments can go to Undeposited Funds and be grouped into a bank
  deposit, which matches the single deposit line on the bank feed.
- Later: check printing (MICR line, voucher layout, check register, Positive
  Pay export) and NACHA ACH files for vendor payment runs.

### 10. Reports

- **Cash and accrual basis** on P&L, balance sheet, trial balance and general
  ledger. The ledger stays accrual; cash basis is computed at report time from
  payment allocations, the way QuickBooks does it: a partial payment is spread
  over the document's lines in proportion to their pre-tax amounts, the rest
  goes to sales tax, AR and AP on unpaid documents drop out, and unapplied
  payments land in "Unapplied cash" income/expense accounts. The entity's
  accounting method sets the default; every report has a toggle.
- **Lock dates** instead of a single closing date: separate locks for sales,
  purchases, tax and the whole period, a hard lock that can't be undone, and
  time-limited, logged exceptions per user (Odoo 18's model). Filing a sales
  tax return sets the tax lock for that agency's period. Today's
  `fiscal_periods.status` becomes the "whole period" lock.
- **Reconciliation undo** for admins, latest reconciliation first, recorded in
  the audit log.
- **Fiscal year** respected by every default date range; comparative columns
  (prior period, prior year); CSV and PDF export.
- **Tax return worksheet**: trial balance grouped by the entity's tax lines
  (Schedule C, 1065, 1120-S or 1120), with the accounts behind each line,
  exportable for the accountant. The mapping is editable per account.
- **Sales tax**: liability by agency and jurisdiction, taxable/exempt sales by
  customer, exemption certificates, exceptions (no ship-to, tax charged in an
  unregistered state, tax not charged in a registered one).
- **1099**: summary and detail by vendor and box.
- **Nexus monitor** (remote-seller phase): sales and transactions per ship-to
  state over each state's measurement period against `us/nexus-thresholds.ts`,
  with warnings at 80% and 100%; "register" opens a new agency.

### 11. Entity setup, terminology and formatting

- **US entity setup**: legal name and DBA, entity type and tax classification,
  EIN (or SSN for a sole proprietor without an EIN, stored encrypted), address
  with state, fiscal year start, accounting method, the states where the
  business is registered for sales tax (each becomes an agency), sales tax
  engine (manual or provider), USD, `en-US`, a US time zone.
- **Entity edit page**, so address, bank details and tax IDs can be maintained
  (it doesn't exist for any jurisdiction today).
- **Terminology from the adapter**: "Sales tax" instead of VAT, "Vendor",
  "Credit memo", "EIN", "Routing number". The `vat` navigation item becomes
  "Tax" and shows the sections the jurisdiction's `features` allow.
- **Formatting**: one `formatDate` / `formatMoney` pair driven by the entity
  locale and the user's `dateFormat` preference; "today" in the user's time
  zone; Letter paper for US PDFs; state on every printed address.
- **One address shape**: the CRM `PostalAddress` (`line1, line2, city, state,
  postalCode, country`, plus optional `county`) everywhere. Entities and
  invoices are migrated from the Dutch shape; invoices gain `shipping_address`;
  bills gain the vendor address. A shared `AddressFields` component with a US
  state picker.

### 12. Schema changes (each needs migration approval)

Tenant DB:

- New: `tax_lines`, `sales_tax_agencies`, `sales_tax_jurisdictions` +
  `sales_tax_jurisdiction_rates` + `sales_tax_zones` +
  `sales_tax_taxability_rules` (manual engine: per agency and tax code, with
  effective dates and taxable percentage),
  `tax_returns`, `exemption_certificates`, `payment_allocations`,
  `bank_deposits`, `bank_connections`, `form_1099_filings` (+ lines),
  `tax_id_reveals` (append-only).
- Changed: `entities` (address shape, `entity_type`, `tax_classification`,
  `accounting_method`, `sales_tax_engine`, encrypted credentials), `tax_rates`
  (`rate numeric(7,4)`, `effective_from/to`), `invoices` (`shipping_address`,
  address shape), `invoice_items` / `bill_items` (`tax_code`, rate precision),
  `bills` (`vendor_address`), `parties` (1099 fields, `sensitive_encrypted`),
  `accounts` (`tax_line`, `form_1099_box`), `payments` (method enum,
  `check_number`, `deposit_id`), `bank_accounts` (routing/account number,
  `account_type`, feed columns), `bank_transactions`
  (`provider_transaction_id`, `source`), `journal_lines` (tax and currency
  columns actually filled).

Master DB: `bank_feed_connection_index` (webhook routing), and the sync
due-index if it lives in master rather than D1.

### 13. API, permissions, events, i18n, docs

- **Routes** in books-api, each new prefix registered in
  `packages/core/api-modules/src/index.ts`: `/api/sales-tax/agencies`,
  `/api/sales-tax/zones`, `/api/sales-tax/calculate` (preview),
  `/api/tax-returns`, `/api/exemption-certificates`, `/api/form-1099`,
  `/api/bank-connections`, `/api/bank-deposits`.
- **Permissions** (app `weldbooks`): new objects `taxes` (read, create, update,
  file) and `tax_ids` (reveal). Reveal is held back from MEMBER by default.
- **Entity events** for every new mutable object (`sales_tax_agency`,
  `exemption_certificate`, `tax_return`, `bank_connection`, `form_1099_filing`)
  added to `packages/core/entity-events/src/events/accounting.ts`. Payloads
  never carry TINs, bank account numbers or provider tokens.
- **external-api**: the generic accounting CRUD stops writing invoices and
  bills directly; it calls the same services as books-api, or those resources
  become read-only until it does.
- **i18n**: every new string in `en` and `nl`; Dutch terms move out of the
  English bundle; US labels come from the adapter's terminology.
- **Help docs**: US guides on help.weldsuite.org (setting up a US company, sales
  tax, exemption certificates, 1099s, bank feeds).

## Phases

Phases 0 to 5 make up the first US release, behind the `weldbooks-us` flag.
Phase 4 (bank feeds) doesn't depend on phases 2 and 3 and can run alongside
them. Sizes are relative: S is a single PR, M two or three, L more.

### Phase 0: ledger foundations (every jurisdiction) — L

| # | Item | What |
|---|---|---|
| 0.1 | Atomic postings | One `postJournalEntry` service using `atomically()`; used by invoice finalize, manual entries and reversals, bank categorize (closes TASK-639) |
| 0.2 | Complete posting | Per-line revenue and expense accounts; tax and currency on journal lines; credit-note signs; bills post on approval; payments post (AR/AP against bank); reconciling a bank line to a document records a payment; recurring invoices compute tax and post on `autoFinalize`. Every posting is idempotent on (source type, source id, event) |
| 0.3 | Server-side tax + tax ledger | `calculateDocumentTax` on every create/update, `tax_lines` written with the journal entry, rates `numeric(7,4)`, the NL VAT return and ICP read `tax_lines`. A one-off backfill (dry run first) writes `tax_lines` for documents already posted |
| 0.4 | Addresses and contacts | One `PostalAddress` shape (data migration from the Dutch shape), address fields and state picker on contacts, persisted tax number/email/phone/terms/notes (TASK-691), invoice ship-to, vendor address on bills, entity edit page |
| 0.5 | Jurisdiction features | `features` and `terminology` on the adapter; NL-only screens (VAT rubrieken, ICP, XAF, KOR, Digipoort) gated on them; Dutch terms out of the English bundle; one date/money formatter driven by entity locale and user `dateFormat`; "today" in local time |
| 0.6 | Payments model | Payment-method enum, `check_number`, `payment_allocations` (one payment, many documents) |
| 0.7 | Crons | books-api `[triggers]`: overdue marking, recurring invoices, FX rates; later the sales tax due-date reminders |
| 0.8 | external-api | Generic accounting CRUD goes through the books services or becomes read-only for documents |
| 0.9 | Lock dates | Sales / purchase / tax / period / hard locks with logged per-user exceptions, enforced in the posting service |

Exit: on an NL entity, invoice → payment → bank match → VAT return produces the
right ledger and return in a pglite test; no posting path writes outside
`atomically()`.

#### Phase 0: what was built

- **Posting service** (`books-api/src/services/accounting-posting.ts`):
  `postJournalEntry` / `reverseJournalEntry` / `postDraftJournalEntry`, one
  `atomically()` batch each (entry, lines, `tax_lines`, account balances,
  document update), idempotent on `journal_entries.posting_key`. Document rules
  live in `accounting-document-posting.ts`; payments (allocations, settlement,
  FX, void) in `accounting-payments.ts`; bank matching and undo in
  `accounting-bank-match.ts`.
- **Every document posts**: invoice finalize and `send` on a draft, credit notes
  (mirrored, dated today), bill approval (rejecting an approved bill reverses
  it), payments (deleting one voids it), bank matches (record a payment),
  categorized bank lines (tax split out when a rate is chosen), write-offs
  (`status: uncollectible`), recurring invoices (`autoFinalize`), manual
  entries. Reversed entries count as booked in every report.
- **One tax calculation** (`calculateDocumentTax`): entity-scoped rates, the
  server's rate wins, `'none'` means no rate, rates `numeric(7,4)`. Purchase
  tax on reverse-charge / EU / import categories is self-assessed (out of the
  bill total, both legs posted). The NL VAT return and ICP read `tax_lines`
  (`computeNlRubrieken`, direction-aware); filing a return stamps its rows and
  moves the tax lock date. Known gap: the XBRL has no VAT fields for 2a/4a/4b,
  so self-assessed VAT is reported as base only (net effect zero).
- **Lock dates**: five dates on `entities` + `lock_date_exceptions`, enforced in
  every posting (`assertPostingAllowed`), set through
  `/api/accounting-entities/:id/lock-dates` and `/lock-exceptions`.
- **Payments**: method enum, `check_number`, `payment_allocations`.
- **Addresses and contacts**: one `PostalAddress` (legacy rows read through
  `normalizePostalAddress`, no data migration), invoice `shipping_address`, bill
  `vendor_address`; accounting contacts wrap a CRM company or person, so email,
  phone, VAT/registration number and notes persist.
- **Jurisdiction `features` / `terminology`** on the adapter; the UI gates NL-only
  screens on them.
- **Crons**: daily 03:00 UTC sweep (`books-api/src/cron/books-sweep.ts`) for
  overdue invoices, due recurring invoices and ECB rates. Workspaces register in
  the WORKSPACE_CACHE KV (`books:active:<org>`) when they call books-api, so the
  sweep only opens tenants that use WeldBooks (no master-DB change).
- **external-api**: accounting resources are read-only (405); contacts stay
  writable for name and role only.
- **Catch-up**: `POST /api/accounting-settings/posting-catch-up` (`dryRun`)
  books what existed before: tax-ledger rows for posted invoices and manual
  entries, credit notes posted with the wrong sign, invoices/bills sent or
  approved without a posting, unposted payments, and bank lines matched without
  a payment. Existing tenants should run it once (preview first).
- **Migration** `0201_weldbooks_ledger_foundations`: `tax_lines`,
  `payment_allocations`, `lock_date_exceptions`, lock dates on `entities`,
  `journal_entries.posting_key` (unique), `invoices.shipping_address`,
  `bills.vendor_address`, `payments.check_number`, rates widened to
  `numeric(7,4)`.

### Phase 1: US entity, chart and reports — M

| # | Item | What |
|---|---|---|
| 1.1 | US adapter | `jurisdictions/us/` with identifiers, states, entity types, invoice format, features, terminology; registered; the two tests that assert `['IN','NL']` updated; `hasAdapter` check added to entity PATCH |
| 1.2 | Chart and tax lines | Base chart + equity per entity type, system roles, Schedule C / 1065 / 1120-S / 1120 line catalogs with default mapping, 1099 box defaults |
| 1.3 | US setup and documents | US entity setup flow, Letter PDF with state on addresses, `en-US` formatting, EIN on documents |
| 1.4 | Reports | Cash/accrual basis, fiscal-year defaults, comparative columns, CSV/PDF export, tax return worksheet |
| 1.5 | US banking basics | Routing/account number and account type (credit cards included), OFX/QFX/QBO import, explicit CSV formats, statement reconciliation, undeposited funds and bank deposits |

Exit: a test LLC (Schedule C) and a test S corp (1120-S) can be set up and run
a month of invoices, bills, payments and reconciliations; cash- and
accrual-basis P&L match a hand-computed fixture.

### Phase 2: sales tax, manual engine — L

| # | Item | What |
|---|---|---|
| 2.1 | Engine + manual engine | `sales-tax/` interface, manual engine, agencies (registrations), jurisdictions, dated rates and zones, product and line tax codes, the registration rule, frozen tax on posted documents |
| 2.2 | Exemption certificates | Table, customer tab, invoice printing, per-state validity rules, expiry and missing-certificate reports with the 90-day cure window |
| 2.3 | Sales Tax Center | Per-agency periods and due dates, return worksheet from `tax_lines`, mark filed, record payment with adjustments, liability check, reminders |
| 2.4 | Reports | Liability by agency and jurisdiction, taxable/exempt sales, exceptions |

Exit: the golden scenarios under "Testing" pass for an origin-sourced state
(Texas) and a destination-sourced state (Washington) with fixture rates.

### Phase 3: provider engine — M

| # | Item | What |
|---|---|---|
| 3.1 | Stripe Tax | Adapter on the calculations API, customer's own restricted key stored encrypted, registration check against WeldBooks agencies, optional commit/reverse for customers who let Stripe file |
| 3.2 | Avalara AvaTax | Second adapter: account ID + license key, address validation, commit on finalize, reverse on credit memo/void |
| 3.3 | Reconciliation | Compare committed provider transactions with `tax_lines` per period; surface differences in the exceptions report |

### Phase 4: bank feeds — M (parallel with 2 and 3)

| # | Item | What |
|---|---|---|
| 4.1 | Package | `@weldsuite/bank-feeds`: interface, normalization, first adapter (Plaid or Stripe Financial Connections), fixture tests |
| 4.2 | Sync | books-api connection routes, account mapping, sync with dedupe and pending handling; master `bank_feed_connection_index`; webhook receiver in `integration-webhook-worker`; due-index sweep in `integration-sync-worker` |
| 4.3 | UI | Connect-bank button with per-provider launchers, connection health, re-auth prompts, disconnect |
| 4.4 | Second adapter | Fallback / extra coverage provider, enabled per country by feature flag |

### Phase 5: 1099 — M

| # | Item | What |
|---|---|---|
| 5.1 | Vendor tax data | 1099 fields, encrypted TIN with reveal permission and reveal log, W-9 upload |
| 5.2 | Computation | Account box mapping, yearly cash-basis totals with card/third-party exclusions, thresholds per tax year, review screen |
| 5.3 | Outputs | Recipient and payer PDFs, IRIS upload file, corrections, email/print delivery |

1099s have a hard calendar: forms for a tax year are due at the end of January
of the next year. Phase 5 has to be live by December for the season it's meant
for, even if other phases slip.

### After the first release

| Phase | What |
|---|---|
| 6. Remote sellers | Nexus monitor, marketplace-facilitator sales flag (counts toward thresholds, no tax collected), multi-state onboarding, use tax accrual on bills, WeldCommerce checkout tax through the same engine |
| 7. Paying vendors | Check printing (MICR line for blank stock, Letter voucher layouts, amount in words, void/reprint, check register), NACHA ACH payment runs (PPD/CCD/CCD+/CTX, balanced or unbalanced per bank, same-day flag, prenotes), Positive Pay export per bank, online W-9 request for vendors. Nacha's 2026 fraud-monitoring rule applies to our customers as originators, so payment runs ship with dual approval and a verification hold when a vendor's bank details change |
| 8. More | Fixed assets with book, federal and state depreciation books (MACRS with the mid-quarter test, Section 179, bonus after the 19 January 2025 cut-off, de minimis expensing); classes and locations as line-level dimensions; payroll journal import (CSV first, then Gusto's general-ledger API); BAI2 import; 52–53-week fiscal years; 1099 e-filing (partner or IRIS A2A) and IRS TIN matching; an income tax due-date calendar per entity type; mobile app parity (`apps/mobile/weldbooks-app` is NL-only today); an EU bank-feed adapter for Dutch customers |

## Testing

- **Domain unit tests** (`packages/domains/books`, vitest): US identifiers (EIN
  prefixes, ABA checksum, ZIP+4), chart integrity (every system role present,
  every account mapped to a tax line), manual-engine scenarios, rounding,
  exemption resolution, nexus measurement, 1099 aggregation, OFX parsing.
- **Golden scenarios** (fixture rates defined in the test, never real-world
  rates that go stale):
  1. Origin state: seller and buyer in the same Texas city, general goods →
     state + city + district components at the seller's location.
  2. Seller registered only in Texas ships to California → no tax,
     `not_registered_in_state`, counted for nexus.
  3. Destination state: Washington seller ships to two Washington ZIPs in
     different zones → each zone's combined rate.
  4. Customer with a valid Florida resale certificate → no tax, sale reported as
     exempt (resale) on the Florida worksheet.
  5. Same customer after the certificate's expiry date → taxed, with a warning.
  6. Shipping line taxable for one agency, non-taxable for another.
  7. Credit memo in the next period → negative `tax_lines`, the next return
     nets it.
  8. 1099: one vendor paid by check and by credit card in the same year → only
     the check counts; below-threshold vendor left out; a corporation left out
     unless it's a law firm; the same payments in 2025 and 2026 checked against
     $600 and $2,000.
  9. Taxability by date and share: a SaaS line taxable at 80% of the price in
     one agency, and a SaaS line that turns taxable on an effective date (as
     California does on 1 January 2027) → untaxed before, taxed after.
- **books-api integration tests** (pglite): US entity seeding; invoice finalize
  writes journal + `tax_lines` in one batch; bill approval; payments with
  allocations; return calculation and payment posting; cash-basis P&L equals
  the fixture.
- **Providers**: recorded HTTP fixtures for every tax-engine and bank-feed
  adapter in CI (sign flips, pending → posted, removed transactions, webhook
  signatures with test keys); a manual sandbox script per provider outside CI.
- **Sweeps**: `_sweeps.test.ts` covers entity events and auth for the new
  routes; the api-modules ownership test covers the new prefixes.
- **E2E** (Playwright): US entity setup → invoice with sales tax → return
  worksheet → payment.

## Risks

- **Wrong tax is the customer's audit problem.** The manual engine is only
  as good as the rates the user enters. Mitigations: say so in the UI, steer
  multi-state sellers to a provider, an exceptions report, and tax that never
  changes after posting.
- **Rules go stale.** Nexus thresholds, 1099 thresholds and tax-line catalogs
  change by law. They live in versioned files with effective dates and source
  URLs, with a yearly review task (December, before 1099 season).
- **Sensitive data.** SSNs and bank account numbers fall under every state's
  breach-notification law, and accountants using WeldBooks are bound by the
  FTC Safeguards Rule. Encrypt them, show the last four, gate reveals behind a
  permission with a log, and keep them out of events, logs, search indexes,
  URLs and AI prompts (the OCR and AI features included).
- **Record retention.** IRS rules need records for 3 to 7 years and an audit
  trail from return to transaction (Rev. Proc. 98-25). Posted entries are never
  deleted; corrections are reversals; master-data changes (vendor bank details,
  TINs) are logged. Never purge accounting data younger than 7 years.
- **Phase 0 touches every posting path** that Dutch customers use today.
  Write pglite tests around the current behaviour before refactoring, ship
  behind the flag, and dry-run the address and `tax_lines` backfills on a copy
  of a tenant DB.
- **No interactive transactions on neon-http.** Postings must be precomputed
  and written as one `atomically()` batch; no read-then-write inside a posting.
- **Aggregator approval and pricing.** Covered by the provider-neutral package
  and a second adapter.
- **Scope creep toward QuickBooks parity.** Phases 6 to 8 stay parked until the
  first release is in customers' hands.

## Open questions

1. Bank feeds: which legal entity owns WeldSuite's Stripe account, and does
   Stripe confirm Financial Connections transaction access for it? Plus the
   outcome of the Plaid application. Together these decide the first adapter
   (section 9).
2. Sales tax providers: the plan takes Stripe Tax first and Avalara second
   (section 3). Say so if you'd rather start with Avalara.
3. Packaging: is US sales tax and 1099 part of the WeldBooks plan or a paid
   add-on? Provider fees are the customer's either way.
4. Migrations: approve the schema list in section 12 per PR as it comes, or as
   one batch up front?
