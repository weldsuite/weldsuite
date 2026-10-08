# Odoo US accounting localization: reference research for WeldBooks

Researched 2026-10-07. Covers Odoo 17.0, 18.0 and 19.0, with saas-19.x/master noted where it differs.

**How I sourced this.** Community code was read directly from github.com/odoo/odoo branches 17.0, 18.0 and 19.0. That covers `account`, `l10n_us`, `l10n_us_account`, `account_check_printing` and `analytic`. These modules are closed-source Enterprise: `l10n_us_check_printing`, `l10n_us_payment_nacha`, `l10n_us_1099`, `l10n_us_reports`, `account_avatax`, `account_asset`, the deferral feature in `account_accountant`, the payroll modules and `account_reports`. For those I describe behaviour and UI labels from odoo.com documentation. Their technical field names could not be verified.

## Key takeaways

- **The US localization is thin.** It is a chart of accounts, US bank-account fields and a set of optional Enterprise modules. Odoo does not try to model US sales-tax jurisdictions itself. Real compliance goes to AvaTax, or to a third-party TaxCloud connector since Odoo 18.
- **19.0 is the first version with a real US chart template** (`l10n_us_account`, template code `us`). In 17.0 and 18.0, US companies get the country-neutral `generic_coa`, which has a placeholder 15% tax.
- **Every filing path stops at a CSV file.** That covers sales-tax returns, 1099 and payroll forms (W-2/940/941). Nothing in standard Odoo e-files with the IRS or a state.
- **Data-model patterns worth copying:**
  - repartition lines (separate base and tax lines, invoice vs refund)
  - a group-of-taxes that produces one ledger line per component tax, with a link back to the group
  - fiscal positions matched on the delivery address (state and ZIP range)
  - the five lock dates from 18.0, with time-boxed exceptions
  - check-number rules
- **Patterns to avoid:**
  - a tax group that is both the invoice-display bucket and the liability account
  - ZIP-range fiscal positions used as a stand-in for tax jurisdictions
  - fiscal-position precedence rules that changed in every version from 17 to 19

## 1. Module inventory

| Module | Edition | Versions | Purpose |
|---|---|---|---|
| `l10n_us` | Community | 17, 18, 19 | Called "United States - Accounting" in 17, where it depends on `account`. Renamed "United States - Localizations" in 18/19, where it depends only on `base`. Sets US Letter paper. Adds `res.partner.bank.l10n_us_bank_account_type` (checking/savings, required). Validates the ABA routing number stored in `clearing_number` as digits only, max 9. |
| `l10n_us_account` | Community | 18 (manifest only), 19 | Auto-installs with `account`. In 19 it adds the `us` chart template, a US tax report, US units of measure (inch, foot, sq ft, lb, oz, gal) and `res.bank.intermediary_bank_id`. |
| `account_check_printing` | Community | all | Generic check engine: numbering, stubs, margins, void. |
| `l10n_us_check_printing` | Enterprise | all | US layouts. 17/18: "Print Check (Top/Middle/Bottom) - US", i.e. QuickBooks/Quicken top, Peachtree middle, ADP bottom, all for pre-printed stock such as checkdepot.net. 19 adds "Print Blank Check (Top/Middle/Bottom) - US". |
| `l10n_us_payment_nacha` | Enterprise | all | NACHA (ACH) files from batch payments. |
| `l10n_us_1099` | Enterprise | all | 1099 CSV export for third-party e-filing. |
| `l10n_us_reports` | Enterprise | all | Check Register. |
| `account_avatax` (+ `account_avatax_sale`, `account_avatax_stock`; optional `account_avatax_geolocalize`, `sale_amazon_avatax`) | Enterprise | all | Avalara AvaTax. Only available when the fiscal country is US, CA or BR. |
| `account_taxcloud` | Enterprise | up to 17 | No new installs in 17, removed in 18. The code was released to TaxCloud and is now maintained by Sodexis as `account_taxcloud_tc` (17/18/19). |
| `l10n_us_hr_payroll`, `_account`, `_adp` | Enterprise | all | US payroll, its accounting entries, and an ADP CSV export. |
| 19 additions | Enterprise | 19 | Vendor payment by direct deposit through Wise ("United States - Direct Deposit"). "U.S. ISO20022" domestic credit transfers. ACH receipts through Authorize.net and Stripe. |

### Chart of accounts by version

**17.0 and 18.0: `generic_coa`.**
- About 44 accounts with 4-digit codes (1010 Current Assets … 9620).
- One "15%" sale tax and one "15%" purchase tax in a single tax group "Tax 15%" (country US).
- The 17.0 docs show the Package field as "Generic Chart Template".

**19.0: `us` template.**
- About 100 accounts with 6-digit codes.
- Account groups: 4 Revenue, 5 COGS, 6 OpEx (61 Payroll, 62 Professional, 64 Utilities, 650 Bank, 651–653 Office, 655 Insurance, 661–664 Travel, 665–669 Auto, 67 Marketing), 7 Other Expenses, 8 Taxes.
- Notable accounts:
  - 201100 Credit Card (`liability_credit_card`)
  - 212000 Deferred Revenue
  - 230000–230200 salary and payroll-tax liabilities
  - 251000 Tax Received, 252000 Tax Payable, 131000 Tax Paid, 132000 Tax Receivable
  - 303000 Common Stock, 304000 Distributions
  - 801000–805000 Federal income tax, State income tax, Local tax, Property tax, Sales tax
  - 999999 "Profit or Loss Appropriation" (unaffected earnings), 999998 Accumulated Retained Earnings
- Company defaults:
  - `anglo_saxon_accounting=True`
  - account code prefixes: bank 1014, cash 1015, transfer 1017 ("Funds in Transit")
- Taxes: one sale and one purchase percent tax for each distinct state base rate (0, 2.9, 4 … 7.25%). Each has its own tax group "Tax X%", and they all post to the same payable and receivable accounts.
- Default company tax: picked from a 51-entry state→rate table keyed on `company.state_id.code` (CA 7.25, TX 6.25, NY 4, OR/MT/NH/DE/AK 0). It falls back to 6% if the company has no state.
- Fiscal positions: "Domestic" (US, auto-apply) and "Foreign Trade" (no country, auto-apply, with 0% export/import taxes).
- Asset models: Technology 36 months, Buildings 468 (39 years), Improvements 180 (15 years), Machines 60, Furniture 84, Vehicles 60, Other 84. The recovery lives match MACRS classes, but every model is **straight-line**.

Sources: https://github.com/odoo/odoo/tree/19.0/addons/l10n_us_account (models/template_us.py, data/template/*.csv), https://github.com/odoo/odoo/tree/18.0/addons/l10n_us_account, https://github.com/odoo/odoo/tree/17.0/addons/l10n_us, https://github.com/odoo/odoo/blob/18.0/addons/account/data/template/account.account-generic_coa.csv, https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/united_states.html, https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/united_states.html

### Check printing

Journal fields:
- `check_manual_sequencing` ("Manual Numbering"). Its help text reads "Check this option if your pre-printed checks are not numbered".
- `check_sequence_id`
- `check_next_number`. Digits only, at most int32, and it can only move forward ("to avoid a check being rejected by the bank").
- `bank_check_printing_layout`, a per-journal override of the company setting.

Company fields:
- `account_check_printing_layout`
- `account_check_printing_date_label`
- `account_check_printing_multi_stub` ("Multi-Pages Check Stub")
- top, left and right margins

Payment fields:
- `check_number`. Digits only, and unique per journal among posted payments.
- `check_amount_in_words`

Printing rules:
- A stub holds 9 invoice lines.
- When checks are pre-numbered, a "Print Pre-numbered Checks" wizard asks for the number on the first sheet, defaulting to the last number + 1.
- `action_void_check` sets the payment to draft and then cancels it, so the number stays on record.
- 19 adds Validate and Reject actions after printing.

On MICR:
- 19's blank layouts print company name, bank account and check number, and the docs say this needs MICR ink or toner and check-quality paper.
- 17/18 had pre-printed stock only.

Sources: https://github.com/odoo/odoo/tree/19.0/addons/account_check_printing, https://www.odoo.com/documentation/19.0/applications/finance/accounting/payments/pay_checks.html

### NACHA

These are set on the bank journal's Outgoing Payments tab:

| Field | Meaning |
|---|---|
| Immediate Destination | Bank routing number |
| Destination | Bank name |
| Immediate Origin | 9-digit company ID / EIN |
| Company Identification | 10 digits, often a leading "1" + EIN |
| Originating DFI Identification | 8 digits |
| Standard Entry Class Code | CCD (default) or PPD |
| Generated Balanced Files | Checkbox; already present in 17 |

How it runs:
- Payments are grouped into a batch payment. Every payment in the batch must use the same NACHA method.
- The file appears on the batch's "Exported File" tab, with a "Re-generate Export File" button.
- There is no separate effective-date field. The docs say to give the payment a future date or send the file before the bank's cut-off.

Gaps filled by partners:
- Hibou's `l10n_us_payment_nacha_balanced` (15/16) exists because the core file used to be unbalanced.
- `us_payment_nacha_memo` (18) adds 05 addenda, which core does not emit.

Sources: 18.0/19.0 US localization pages, https://apps.odoo.com/apps/modules/16.0/l10n_us_payment_nacha_balanced, https://apps.odoo.com/apps/modules/18.0/us_payment_nacha_memo

### 1099

Configuration:
- Accounting > Configuration > "1099 Boxes" holds name/description records.
- Each vendor gets a "1099 Box" on the contact's Sales & Purchase tab, Purchase section.

The report:
- Accounting > Reporting > (Management) > 1099 Report opens a wizard with Start Date and End Date.
- It pre-fills posted payment (liquidity) journal items for partners that have a 1099 box. The columns are Date, Partner, Journal, Account, Label, Debit, Credit.
- The user can "Add a line" or delete lines, then "Generate" a CSV grouped by partner. The CSV is meant for a third-party e-filing service.

What it does not do:
- no TIN/W-9 tracking
- no threshold logic
- no recipient copies
- no IRIS/FIRE file

Sources: 19.0 US page, https://www.odoo.com/documentation/19.0/applications/essentials/contacts.html, https://www.cybrosys.com/odoo/odoo-books/v18/accounting/1099-boxes/

### AvaTax

Settings (Accounting > Settings > Taxes):
- Environment (Sandbox or Production)
- API ID (the Avalara account ID)
- API Key (the license key)
- Company Code (blank means DEFAULT)
- Address Validation
- Use UPC
- Commit Transactions
- Buttons: Test connection, and Sync Parameters, which pulls exemption codes from Avalara

Integration Method (saas-19.3 and master only, not on-premise 19.0):
- **"Avalara Included"** runs on Odoo IAP credits. One credit is used per posted invoice or credit note, with a cap of 5,000 transactions a year and first-line support from Odoo.
- **"Avalara Direct"** uses the customer's own Avalara contract.

Data hooks:
- A fiscal position "Automatic Tax Mapping (AvaTax)" with "Use AvaTax API" ticked and an AvaTax tab holding the "AvaTax Invoice Account" and "AvaTax Refund Account". "Detect Automatically" applies the same country, state and ZIP filters as any other fiscal position.
- "AvaTax Category" on the product and on the product category. The product's value wins.
- "Avalara Partner Code" and an exemption code on the customer.
- Address validation via "Validate" and "Save Validated" on a contact. North America only; Country, State and ZIP are the minimum.

When tax is calculated and committed:
- Tax is calculated when a quote is emailed or viewed on the portal, when an SO is confirmed, when an invoice is validated, and at eCommerce checkout. A manual "Compute Taxes" button exists while the document is a draft.
- Posting the invoice commits it to Avalara.
- A posted AvaTax invoice **cannot be reset to draft**, because that would de-sync it. Reversal is done with a credit note, which is synced as a return.

Limits:
- No excise taxes.
- The origin is the company address, unless POS "Allow Ship Later" is used.

Sources: https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/avatax.html, https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/avatax/avatax_use.html, https://www.odoo.com/documentation/master/applications/finance/accounting/taxes/avalara.html

### TaxCloud successor

`account_taxcloud_tc`:
- TIC category on the product and the category, plus a company default, with a daily TIC sync.
- An Exemption menu, gated by the "Manage TaxCloud Exemption" group. A parent contact's exemption flows to child contacts that ship to the same state.
- Posting an invoice marks it "Captured" in TaxCloud. A credit note becomes a Return, and a cancellation calls the Return API.

Source: https://apps.odoo.com/apps/modules/18.0/account_taxcloud_tc

### Payroll (19.0)

Coverage:
- Federal income tax, FICA and FUTA for employee and employer by default.
- State rules for AL, AZ, CA, CO, FL, GA, ID, IL, IA, MS, NV, NJ, NY, NC, OR, TX, VT, VA, WA and DC ("more states will be added").

Outputs:
- W-2, 941 and 940 as CSV files for third-party filing.
- Employees are paid through NACHA.

Employee fields:
- federal "Status", state "Tax Status", "Withholding Allowance", "Extra Withholding", W-2 box 13 checkboxes

What it does not do:
- no filing or remittance
- An ADP export exists for companies that outsource payroll.
- In 17/18 the payroll documentation lived inside the fiscal-localization page.

Source: https://www.odoo.com/documentation/19.0/applications/hr/payroll/payroll_localizations/united_states.html

## 2. US sales tax without AvaTax

### Default setup

- **17/18:** only the 15% placeholder exists. The user builds everything.
- **19:** one tax per state base rate, and the company default is its home-state rate. There are no county, city or district taxes and no per-state fiscal positions. A seller shipping into other states must add those positions or turn on AvaTax.
- Odoo's own forum shows a v18 user who asked for state-then-county tracking without an external service. The replies offered "mapping through fiscal position setups", which the user found "overwhelming" with 50–100 counties per state, or Avalara/TaxAvenger. https://www.odoo.com/forum/help-1/sales-tax-setup-v18-273609

### The native pattern

1. **Component taxes per jurisdiction.**
   - Create one `percent` tax per jurisdiction (state, county, city, district).
   - Set `type_tax_use='none'`. The docs say to use None "for taxes that you want to include in a Group of Taxes".
   - Give each its own repartition-line account if liabilities must stay apart. Otherwise point them all at a shared "Sales Tax Payable".
2. **Group of taxes.**
   - Set `amount_type='group'` with `children_tax_ids`, e.g. "CA – Los Angeles" = state + county + district.
   - Posting creates **one journal item per child tax**. Each item carries:
     - `tax_line_id` (the child)
     - `group_tax_id` ("Originator Group of Taxes")
     - `tax_repartition_line_id`
     - `tax_tag_ids`
     - `tax_base_amount`
   - Liability per jurisdiction is therefore kept in the ledger.
3. **Fiscal positions decide which group applies.**
   - One position per state, or per ZIP range for local rates, with `auto_apply`, `country_id=US`, `state_ids` and `zip_from`/`zip_to`.
   - Each maps the product's default "sales tax" to the right group.
   - Matching uses the **delivery address**. A position set manually on the partner (`property_account_position_id`) always wins.
   - Tax-exempt customers get a manual "Exempt" position that maps to no tax or to 0%. There is no certificate number or expiry.
4. **Goods vs services.** `tax_scope` (`consu`/`service`) limits which products a tax applies to, which matters for states that don't tax services.
5. **Use tax on purchases.** A purchase tax with +100% and −100% tax repartition lines books accrued use tax that nets to zero for the vendor. This is the reverse-charge pattern.

### How fiscal-position matching changed by version

| Version | Matching rule |
|---|---|
| 17 | A specificity cascade: country + state + ZIP, then country + ZIP, then country + state, then country, then country group, then a catch-all. Ties go to `sequence`. |
| 18 | A ranking tuple: VAT required, company depth, ZIP, state, country, country group, then lowest `sequence`. |
| 19 | The **first match** sorted by company depth and then `sequence`. Specificity no longer wins on its own, so a ZIP-level position must have a lower sequence than its state-wide position. |

Two other details:
- ZIPs are zero-padded and **compared as strings**.
- 19 removed the mapping-line model `account.fiscal.position.tax` (`tax_src_id` → `tax_dest_id`).
  - Taxes now carry `fiscal_position_ids` and `original_tax_ids` ("Replaces").
  - A tax with no positions is available everywhere.
  - `map_tax` swaps each tax for its replacements within the position.

Sources: https://github.com/odoo/odoo/blob/17.0/addons/account/models/partner.py, https://github.com/odoo/odoo/blob/18.0/addons/account/models/partner.py, https://github.com/odoo/odoo/blob/19.0/addons/account/models/partner.py, https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes.html

### Cash-basis taxes

- Setup: company `tax_exigibility` ("Cash Basis"), a Tax Cash Basis Journal (CABA), a "Base Tax Received Account", and per tax `tax_exigibility='on_payment'` with a `cash_basis_transition_account_id`.
- Tax sits in the transition account until the payment is reconciled. A CABA entry then moves it to "Tax Received" and adds offsetting base lines so the tax report stays correct.

Source: https://www.odoo.com/documentation/18.0/applications/finance/accounting/taxes/cash_basis.html

### Reporting per jurisdiction

- The generic tax report groups by tax or by account. In 19, the US variant is `l10n_us_account.tax_report` (Net and Tax columns, child of `account.generic_tax_report`).
- Because every component tax is its own record, the report gives per-jurisdiction net and tax totals.
- Tax grids (`account.account.tag` on repartition lines) can feed a custom per-state report.
- There is no state return layout. Partners sell one, e.g. Pokutsoft's `us_sales_tax_return_worksheet`, which produces per-state taxable/exempt/jurisdiction CSV files. https://apps.odoo.com/apps/modules/19.0/us_sales_tax_return_worksheet

### Closing and paying each state

- The tax closing entry zeroes the tax accounts and posts the net to the **tax group's** `tax_payable_account_id` (or `tax_receivable_account_id`). It subtracts anything posted to `advance_tax_payment_account_id`.
- To pay each state separately: give each state its own tax group with its own payable account, then reconcile the payment to that state's agency against the account. In 19, 252000 is `liability_payable`, reconcilable and `non_trade`.
- Posting the closing sets the Tax Return Lock Date (18+).
- 19 adds a Tax Returns dashboard:
  - Review runs checks: bank matching, bill attachments, company data, drafts, negative amounts, with an "Anomaly" override.
  - Validate posts the closing to the "Tax Returns" journal.
  - Then Submit / "Mark as Submitted", and a Pay window (QR code where supported) with "Mark Paid".
  - The Return Types are country-level. There are no US-state return types.
- A fiscal position with a `foreign_vat` ("Foreign Tax ID") inside the company's own fiscal country *must* name a state. The community constraint enforces this.
  - Odoo's Enterprise tax report can split returns by foreign-tax-ID fiscal position. That machinery could carry state sales-tax permits.
  - That is my inference. It is not documented for the US.

Sources: https://github.com/odoo/odoo/blob/19.0/addons/account/models/account_tax.py, https://www.odoo.com/documentation/19.0/applications/finance/accounting/reporting/tax_returns.html

## 3. Accounting features relevant to US users

### Reporting basis and year-end

- **Cash vs accrual reporting.** Reports default to "Accrual Basis". Cash basis is an option on each report: enable "Cash Basis" in the report's Options (developer mode), then pick "Cash Basis Method". https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/cash_basis.html
- **Fiscal year.**
  - Set with `fiscalyear_last_day` and `fiscalyear_last_month`. There are no period records.
  - Earnings roll up automatically to the unaffected-earnings account.
  - The year-end docs recommend a manual entry that moves current-year earnings to retained earnings, followed by locking.

### Lock dates

**17:**
- `period_lock_date` (applies to non-advisers)
- `fiscalyear_lock_date` (applies to everyone)
- `tax_lock_date`

**18/19:**
- `fiscalyear_lock_date` ("Global Lock Date")
- `tax_lock_date` ("Tax Return Lock Date"), set automatically when the closing posts
- `sale_lock_date`
- `purchase_lock_date`
- `hard_lock_date`, which is irreversible and allows no exceptions

Exceptions (`account.lock_exception`):
- Fields: `user_id` (empty means everyone), `lock_date_field`, `end_datetime` (or "forever"), `reason`, `state`.
- Logged in the company chatter.

Behaviour: an entry dated inside a locked period is **postponed** to the next open date according to its journal's sequence, not rejected.

Sources: https://github.com/odoo/odoo/blob/18.0/addons/account/models/company.py, https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/year_end.html

### Structure

- **Multi-company.**
  - Branches (17+) are child companies that share the parent's chart and taxes.
  - Fiscal positions prefer the most specific company.
  - Tax units allow an aggregated report.
- **Analytic accounting as US "classes".**
  - `account.analytic.plan` is hierarchical, with applicability per business domain: optional, mandatory or unavailable.
  - `analytic_distribution` is a JSON field on move lines that splits by percentage across accounts in several plans.
  - Distribution models apply automatically.
  - QuickBooks Class and Location map naturally onto two plans.

### Revenue, assets and budgets

- **Deferred revenue/expense (17+, Enterprise).**
  - Start Date and End Date on invoice and bill lines.
  - Settings: Journal, Deferred Revenue/Expense account, Generate Entries (on validation, or "Manually & Grouped" with a month-end entry and its reversal), and "Based on" (Months, Full Months, Days).
  - A Deferred Revenue report.
  - https://www.odoo.com/documentation/18.0/applications/finance/accounting/customer_invoices/deferred_revenues.html
- **Assets (Enterprise).**
  - Methods: "Straight Line", "Declining" (with a "Declining Factor"), "Declining Then Straight Line".
  - Prorata temporis.
  - "Not Depreciable Value" (salvage).
  - Actions: "Sell or Dispose" (books the gain or loss) and "Modify Depreciation" (including "Gross Increase").
  - Asset models.
  - **No MACRS, no half-year/mid-quarter conventions, no §179 or bonus depreciation, and no separate tax book.**
  - https://www.odoo.com/documentation/18.0/applications/finance/accounting/vendor_bills/assets.html
- **Budgets.**
  - 17 uses "crossovered" budgets with budgetary positions.
  - 18 rebuilt budgets on analytic accounts, with Achieved, Committed (Achieved + confirmed, unbilled POs) and Theoretical amounts, plus revisions.
  - 18 also added financial budgets entered directly on the P&L, with a % column.
  - https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/budget.html

### Banking

- **Check Register** (`l10n_us_reports`): all liquidity transactions with a running balance.
- **Bank synchronization (Enterprise only).**
  - Providers:
    - Plaid for the US and Canada
    - Salt Edge worldwide
    - Yodlee, worldwide in the 17 docs and Europe-only in 18/19
    - Ponto and Enable Banking for Europe
    - Basiq for Australia
  - Syncs every 12 hours and fetches posted transactions only. Some institutions give only 3 months of history.
  - https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/bank_synchronization.html
- **Statement import.**
  - Formats: CAMT.053 (recommended), CSV and XLSX (with column mapping), OFX, QIF, CODA.
  - Duplicate detection on amount + date + account number, plus the provider's transaction ID.
  - https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/transactions.html
- **Reconciliation.** A bank-matching widget plus reconciliation models (counterpart buttons, suggestion rules, invoice-matching rules).

### Invoices and terms

- **Invoice layout.**
  - US Letter paper.
  - US address format "city STATE zip" (`state_required`). The US `vat_label` is blank, so the Tax ID/EIN appears without a label.
  - Totals are grouped by tax group. In 19 that means one line per rate group ("Tax 7.25%"). `preceding_subtotal` can insert a subtotal before a group.
- **Cash discounts** live on payment terms (e.g. 2/10 net 30), and the tax can be reduced along with the discount.

## 4. Data model details worth copying

### `account.tax`

- `type_tax_use` (sale / purchase / none)
- `tax_scope` (service / consu)
- `amount_type` (group / fixed / percent / division; plus `code` via `account_tax_python`)
- `amount` (16,4 precision)
- `children_tax_ids`, `sequence`
- `price_include`
  - A boolean in 17.
  - From 18 it is computed from `price_include_override` (tax_included / tax_excluded) against the company's `account_price_include` (default tax_excluded, which is correct for the US).
- `include_base_amount` ("Affect Base of Subsequent Taxes")
- `is_base_affected` ("Base Affected by Previous Taxes", default True)
- `tax_group_id`, `analytic`
- `tax_exigibility`, `cash_basis_transition_account_id`
- `invoice_repartition_line_ids`, `refund_repartition_line_ids`
- `country_id`, `invoice_label`
- `description` (Html in 19), `invoice_legal_notes` (19)
- 19 only: `fiscal_position_ids`, `original_tax_ids`, `replacing_tax_ids`, `is_domestic`

### `account.tax.repartition.line`

- `document_type` (invoice / refund)
- `repartition_type` (base / tax)
- `factor_percent` (may be negative)
- `account_id`
- `tag_ids` ("Tax Grids")
- `use_in_tax_closing`, `sequence`

### `account.tax.group`

- `name`, `sequence`, `country_id`
- `tax_payable_account_id`, `tax_receivable_account_id` (the counterparts in the closing entry)
- `advance_tax_payment_account_id`
- `preceding_subtotal`, `pos_receipt_label` (19)

### Tax fields on `account.move.line`

- `tax_ids`, `tax_line_id`, `group_tax_id`
- `tax_repartition_line_id`, `tax_tag_ids`
- `tax_base_amount`
- `analytic_distribution`

### `account.fiscal.position`

- `name`, `sequence`, `company_id`
- `auto_apply` ("Detect Automatically")
- `vat_required`
- `country_id`, `country_group_id`
- `state_ids` ("Federal States")
- `zip_from`, `zip_to`
- `foreign_vat` ("Foreign Tax ID")
- `note` (legal mention printed on invoices)
- `account_ids` (`account.fiscal.position.account`: `account_src_id` → `account_dest_id`)
- `tax_ids`: an O2M of `tax_src_id` → `tax_dest_id` in 17/18; an M2M of replacement taxes in 19
- `is_domestic` (19)
- AvaTax adds a "Use AvaTax API" flag and invoice/refund accounts. These are Enterprise fields; the labels are verified, the field names are not.

### Partner

- `vat` (Tax ID)
- `property_account_position_id` (company-dependent)
- Enterprise, labels only: "1099 Box", "Avalara Partner Code" and an Avalara exemption code
- Bank: `acc_number`, `clearing_number` (ABA), `l10n_us_bank_account_type`

### Product

- `taxes_id`, `supplier_taxes_id`
- "AvaTax Category" on the product and the category
- The UPC (barcode) is used when "Use UPC" is on.
- Third-party: TaxCloud TIC.

### Company

- `account_fiscal_country_id`
- `tax_exigibility`, `tax_cash_basis_journal_id`, `account_cash_basis_base_account_id`
- `account_price_include`
- the lock dates, `fiscalyear_last_day/month`
- `anglo_saxon_accounting`

## 5. Gaps, complaints and how partners fill them

- **Sales-tax rates and filing.**
  - No county, city or district rates.
  - No nexus tracking or economic-nexus thresholds.
  - No exemption certificates.
  - No state return formats and no filing.
  - The usual answer is AvaTax, where Avalara's returns and filing are a paid add-on. The alternatives:
    - TaxCloud via Sodexis
    - TaxAvenger
    - OCA `l10n_us_sales_tax_engine` (ZIP-based rate engine, alpha)
    - commercial "all 50 states" rate apps
    - Pokutsoft return worksheets
- **1099.**
  - Native output is CSV only.
  - The OCA `l10n_us_form_1099` adds a "Is a 1099" flag, a 1099 type and a MISC box.
  - Vendors (e.g. Ecosire) advertise fixed-width IRS e-file output and recipient copies; these claims are unverified.
- **Payroll.**
  - 19 covers 19 states plus DC.
  - Forms are CSV only, with no filing or remittance.
  - Many users export to ADP, or historically used Hibou's US payroll.
  - Third-party 940/941 worksheet apps exist, e.g. Pokutsoft `us_form_940_941_payroll_tax_worksheet`.
- **MACRS.**
  - Nothing native.
  - Pokutsoft `us_macrs_depreciation_tax_book_schedule` (18/19) adds GDS classes, half-year, mid-quarter and mid-month conventions, §179, bonus depreciation, the mid-quarter test and the book-tax difference. https://apps.odoo.com/apps/modules/19.0/us_macrs_depreciation_tax_book_schedule
- **NACHA and checks.**
  - No addenda and no positive-pay file.
  - Few check layouts. Vendors sell per-bank layouts with MICR positioning.
- **Bank sync** needs an Enterprise subscription.

## 6. Trade-offs and implications for WeldBooks

1. **Fiscal positions by state.**
   - Odoo's design is generic, one rule engine serving EU OSS, India GST, Canadian provinces and US states.
   - The cost is one record per jurisdiction combination. ZIP ranges don't line up with tax jurisdictions (ZIPs cross city and county lines), the string comparison is brittle, and precedence changed in 17, 18 and 19.
   - Recommendation: model jurisdictions explicitly (state, county, city, special district) and resolve rates from a rate source or provider by ship-to address. Keep a fiscal-position-like "tax rule" only for exemption, resale, export and marketplace-facilitator cases.
2. **Tax groups.**
   - In Odoo a tax group is both the invoice-display bucket and the payable account used at closing.
   - US filing needs a "tax agency" concept instead: component tax → agency → liability account → filing frequency and permit number. Display grouping should stay a separate concern.
3. **Group of taxes plus per-component ledger lines.** Copy this: `tax_line_id`, `group_tax_id` and `tax_base_amount` on every tax line make per-jurisdiction liability and audit trivial.
4. **Repartition lines** (invoice vs refund, base vs tax, signed factors, tags). Copy this: it handles use tax, partial recoverability and report mapping without special cases.
5. **AvaTax as a pluggable engine selected by fiscal position.**
   - This works well: the engine is chosen per transaction by the same address-matching rules, and its results become ordinary tax records and ledger lines, so reporting stays native.
   - Costs: a commit on posting, posted invoices locked against reset-to-draft, per-document IAP credits in "Included" mode, and a dependence on product tax codes.
   - WeldBooks could define a provider interface (calculate / commit / void / refund) that Avalara, TaxJar or an internal table engine can implement.
6. **Lock dates.** The 18 model is worth mirroring: separate sales, purchase, tax, global and hard locks, plus audited, time-boxed exceptions per user.
7. **Filing gap.** Odoo stops at CSV for sales tax, 1099 and payroll. Per-state return worksheets, a filing calendar, and 1099 data with TIN/W-9 status and thresholds would be a clear differentiator.
8. **Checks and NACHA.** Copy the numbering rules (forward-only, unique among posted, pre-numbered wizard, void keeps the number) and the NACHA journal fields. Add an explicit effective entry date, balanced/unbalanced choice, and addenda support.

## Sources

**Odoo documentation**
- https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/united_states.html
- https://www.odoo.com/documentation/18.0/applications/finance/fiscal_localizations/united_states.html
- https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/united_states.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/taxes/fiscal_positions.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/avatax.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/avatax/avatax_use.html
- https://www.odoo.com/documentation/master/applications/finance/accounting/taxes/avalara.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/taxes/cash_basis.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/taxes/cash_basis.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/reporting/tax_returns.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/year_end.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/customer_invoices/deferred_revenues.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/vendor_bills/assets.html
- https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/budget.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/bank_synchronization.html
- https://www.odoo.com/documentation/17.0/applications/finance/accounting/bank/bank_synchronization.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/transactions.html
- https://www.odoo.com/documentation/19.0/applications/finance/accounting/payments/pay_checks.html
- https://www.odoo.com/documentation/19.0/applications/essentials/contacts.html
- https://www.odoo.com/documentation/19.0/applications/hr/payroll/payroll_localizations/united_states.html

**GitHub (Odoo source)**
- https://github.com/odoo/odoo/tree/19.0/addons/l10n_us_account
- https://github.com/odoo/odoo/tree/18.0/addons/l10n_us_account
- https://github.com/odoo/odoo/tree/17.0/addons/l10n_us
- https://github.com/odoo/odoo/blob/19.0/addons/l10n_us/models/res_partner_bank.py
- https://github.com/odoo/odoo/tree/18.0/addons/account/data/template
- https://github.com/odoo/odoo/blob/19.0/addons/account/models/account_tax.py
- https://github.com/odoo/odoo/blob/17.0/addons/account/models/partner.py
- https://github.com/odoo/odoo/blob/18.0/addons/account/models/partner.py
- https://github.com/odoo/odoo/blob/19.0/addons/account/models/partner.py
- https://github.com/odoo/odoo/blob/18.0/addons/account/models/company.py
- https://github.com/odoo/odoo/blob/18.0/addons/account/models/account_lock_exception.py
- https://github.com/odoo/odoo/blob/19.0/addons/account/models/account_move_line.py
- https://github.com/odoo/odoo/tree/19.0/addons/account_check_printing
- https://github.com/odoo/odoo/tree/18.0/addons/analytic/models

**Apps, forum and third parties**
- https://apps.odoo.com/apps/modules/18.0/account_taxcloud_tc
- https://apps.odoo.com/apps/modules/19.0/us_sales_tax_return_worksheet
- https://apps.odoo.com/apps/modules/19.0/us_macrs_depreciation_tax_book_schedule
- https://apps.odoo.com/apps/modules/18.0/l10n_us_form_1099
- https://apps.odoo.com/apps/modules/16.0/l10n_us_payment_nacha_balanced
- https://apps.odoo.com/apps/modules/18.0/us_payment_nacha_memo
- https://www.odoo.com/forum/help-1/sales-tax-setup-v18-273609
- https://www.cybrosys.com/odoo/odoo-books/v18/accounting/1099-boxes/
