# QuickBooks Online (US): how it handles US accounting, as a reference for WeldBooks

Researched 7–8 October 2026. Sources are Intuit help articles, Intuit developer docs, Intuit product pages and dated trade press. Where only third parties (often competitors) report something, the text says so. "Copy" and "Avoid" notes are recommendations for WeldBooks.

## Summary

- **Sales tax is QBO's strongest feature and its most complained-about one.** Automated Sales Tax (AST) builds a state + county + city + district rate from the ship-to address, the item's tax category and the customer's exemption, shows the breakdown, and keeps one payable account per agency. The Sales Tax Center tracks each agency's returns per period with typed adjustments. Gaps: one tax code per document, an untaxable shipping field, no certificate storage, no amended returns, overrides lost on edit, sales-only nexus tracking, and e-file in only 19 states as a paid add-on.
- **The 1099 workflow is solid and worth copying.** It has a vendor flag, TIN and W-9 status, account-to-box mapping, automatic card/PayPal exclusion, a threshold review step and federal + CF/SF filing. The 2026 $2,000 threshold shows thresholds must be stored per tax year.
- The ledger is always accrual, and cash-basis reports are derived from it by prorating payments across lines. WeldBooks should do the same.
- Dimensions are QBO's weakest design area: classes per line, locations per document, a cap of 40 on Plus, Tags retired in 2025. WeldBooks should start with line-level dimensions, as Intuit Enterprise Suite now has.

---

## 1. Company setup

- **Business type and tax form.** Settings > Account and settings > Company (newer UI: Legal info). The *Tax form* choices are Sole proprietor (Schedule C), Partnership or LLC (1065), S corporation (1120-S), C corporation (1120), Nonprofit (990) and Other. The choice sets the default chart of accounts and the tax-line taxonomy that Prep for taxes uses, and changing it later can unmap accounts. The labels are imprecise: an LLC taxed as an S corp has to pick the S corp option. (https://quickbooks.intuit.com/learn-support/en-us/account-management/re-company-information-income-tax-form-used-1120-vs-1120s/01/226314/highlight/true ; https://open-exam-prep.com/study-guides/quickbooks-proadvisor/ch02-client-onboarding/company-setup-preferences)
- **Equity.** Opening Balance Equity and Retained Earnings are system accounts, and net income closes to Retained Earnings at year end with no stored entry. Equity detail types cover each entity: Owner's Equity and Personal Expense (sole proprietor); Partner Contributions and Partner Distributions (partnership); Common Stock, Paid-in Capital, Treasury Stock and Accumulated Adjustment, the S corp AAA (corporation). (enum list: https://cdn.cdata.com/help/RNN/py/pg_table-accounts.htm)
- **Fiscal year vs. tax year.** Advanced > Accounting has two separate settings: *First month of fiscal year* and *First month of income tax year* (either "same as fiscal" or January). (https://quickbooks.intuit.com/community/reports-accounting-69/how-do-i-set-a-year-to-be-june-30-161274)
- **Accounting method.** The Cash/Accrual preference only sets the default basis; every report has its own toggle. The ledger is accrual and cash basis is derived at report time. Revenue and expense count when payments are applied; a partial payment is prorated across lines by pre-tax subtotal, with the remainder to sales tax; A/R and A/P drop off the balance sheet; unapplied payments go to *Unapplied Cash Payment Income* / *Unapplied Cash Bill Payment Expense*. A/R or A/P still shows up when payments are unapplied or journal entries hit them. (https://quickbooks.intuit.com/learn-support/en-us/sales-taxes/handle-cash-basis-sales-tax/00/248797 ; https://quickbooks.intuit.com/learn-support/en-us/help-article/set-inventory-lists/resolve-ar-ap-balances-cash-basis-balance-sheet/L8XR76bVQ_US_en_US)
- **Closing the books.** One closing date (newer help calls it a "lock date"), with either "warning only" or "warning plus password". There are no per-month or per-module locks, so users move the date forward each month. Overrides appear in the *Exceptions to Closing Date* report. (https://quickbooks.intuit.com/learn-support/en-us/customer-company-settings/how-to-close-the-books/00/186384)
- **EIN/SSN.** Company Legal info holds the legal name, legal address and EIN or SSN, which feed 1099s, payroll and sales tax e-file.

**Copy:** an accrual ledger with cash basis computed at report time, using the proration rule and the unapplied-payment accounts; separate fiscal and tax years; an entity type that seeds the chart of accounts and equity accounts. **Avoid:** a single global closing date with a shared password. Use per-period locks with role-based, logged overrides instead.

## 2. Chart of accounts

- **Account record.** Classification (read-only: Asset, Liability, Equity, Revenue, Expense), account type, detail type (`AccountSubType`), an optional account number (turned on with "Enable account numbers"), parent account (colon path), currency, opening balance and date, active flag. `TaxCodeRef` on accounts exists only outside the US. (https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-bookkeeping/accounts)
- **The 15 US account types.** Bank, Accounts Receivable, Other Current Assets, Fixed Assets, Other Assets, Accounts Payable, Credit Card, Other Current Liabilities, Long Term Liabilities, Equity, Income, Cost of Goods Sold, Expenses, Other Income, Other Expense. (https://tprosupport.rightworks.com/kb/article/842-quickbooks-online-chart-of-accounts-import-valid-account-type-values/)
- **Representative detail types:** Other Current Assets has Undeposited Funds, Inventory, Prepaid expenses. Other Current Liabilities has **Sales Tax Payable**, Payroll Tax Payable, Payroll Clearing, Direct Deposit Payable. Income has Sales of product, Service/fee income, Discounts/refunds given. Expenses include Travel meals vs. Promotional meals (for the 50% split), plus home-office and vehicle types aimed at Schedule C filers. Other Expense has Depreciation, Exchange gain/loss, Penalties & settlements. Detail types don't change the accounting; they drive feature defaults and tax mapping. (https://quickbooks.intuit.com/learn-support/en-us/help-articles/organize-your-accounts-with-detail-types/00/262144)
- **System accounts (cannot be deleted).** A/R, A/P, **Undeposited Funds** (shown as "Payments to deposit" in some files, per an Intuit reply from November 2025; find it by detail type), Opening Balance Equity, Retained Earnings, Inventory Asset, the unapplied-cash accounts, Reconciliation Discrepancies, Exchange Gain or Loss, one "<Agency> Payable" per sales tax agency, and the payroll accounts. Payments wait in Undeposited Funds until they are grouped into one Bank Deposit that matches the bank-feed line. This is the most common cause of double-counted income. (https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/re-undeposited-funds/01/1158827/highlight/true)
- **Tax-line mapping** is not on the account record. It lives only in the QBO Accountant tool *Prep for taxes*: accounts map to form lines automatically from their detail type, an "unmapped accounts" list offers *Assign tax line*, switching forms discards your edits, and the result exports to ProConnect (Schedule C, 1120-S) or to Lacerte as CSV. (https://quickbooks.intuit.com/learn-support/en-us/help-article/map-forms-accounts/use-prep-taxes-map-export-clients-tax-info/L4EUJdqX3_US_en_US)
- **Limits.** 250 accounts on Simple Start, Essentials and Plus; unlimited on Advanced. (https://quickbooks.intuit.com/learn-support/en-us/help-article/intuit-subscriptions/learn-usage-limits-quickbooks-online/L6THMltE4_US_en_US)

**Copy:** the classification > type > detail type hierarchy, with detail type as the hook for defaults and tax mapping; optional account numbers; non-deletable system accounts; a payments-to-deposit clearing flow. **Avoid:** account caps, and tax mapping that only accountants can reach. Store an optional tax line per account per form, prefilled from the detail type.

## 3. Sales tax

### 3.1 Engine and calculation
- US companies created after November 2017 use **Automated Sales Tax (AST)**; older files may still use manual rates. Staff say new files get no manual option, AST can't be turned off once transactions depend on it, and the move to AST can't be reversed. Sales tax is enabled in the UI only; the API can't turn it on. (https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-sales-tax-for-us-locales ; https://quickbooks.intuit.com/community/taxes-8/automated-sales-tax-errors-16427)
- **Inputs:** date, location, product type and customer. (https://quickbooks.intuit.com/features/sales-tax/)
  - **Location.** The source is the company's legal address. The destination is the transaction's ship-to address, falling back to the billing address and then the company address. Rate = state + county + city + district. The REST API doesn't support a per-transaction ship-from address, though the UI lets the user change the "sale location". (https://quickbooks.intuit.com/learn-support/en-us/help-article/sales-taxes/learn-quickbooks-online-calculates-sales-tax/L8VWCLobK_US_en_US)
  - **Sourcing.** Eleven origin states are built in for in-state sales: AZ, CA, IL, MS, MO, OH, PA, TN, TX, UT, VA. California is mixed (district taxes are destination-based), and Ohio and Texas source some services to the buyer. Sales into other states are destination-based. (https://quickbooks.intuit.com/learn-support/en-us/help-article/business-taxes/understand-sales-tax-destination-origin-states-quickbooks-online/L7bLvBk3O_US_en_US)
  - **Item taxability.** Each product or service is "Taxable – based on location only", "Nontaxable", or a **special sales tax category** found by searching a description (for example Food and Drink > soft drinks). Uncategorised items get the standard rate. Intuit publishes no list of categories and no report showing which category each item has, both long-running complaints. (https://community.intuit.com/content/p_na_na_gl_cas_na_article:L66p3ybk9_US_en_US ; https://feedback.qbo.intuit.com/forums/920245-quickbooks-mobile-feedback-forum/suggestions/41406643-products-services-report-that-displays-an-item)
  - **Exemption.** The customer record has a "This customer is tax exempt" checkbox plus a *Reason for exemption* (government, resale, charitable, religious, educational, etc.; API `TaxExemptionReasonId`). There is **no certificate number, expiry date or document**. Intuit warns that exempt customers can still be taxed in some states.
  - **Shipping.** The invoice's Shipping field is never taxed. The workaround is a shipping service item with a tax category. (https://quickbooks.intuit.com/learn-support/en-us/payments/shopify-shipping/00/1222284)
- **Per document.** AST assigns one combined tax code to the whole document, and lines only say TAX or NON. *See the math* shows the breakdown by jurisdiction and lets the user override the amount. AST recalculates on every edit, so the override has to be entered again.

### 3.2 Setup, agencies, custom rates
- **Setup flow.** Sales Tax > Use automatic sales tax > confirm the business address > "collect tax outside your state?" > add agencies. Each agency has its own **filing frequency** (monthly, quarterly, semi-annual or annual), **start date** and **reporting basis (cash or accrual)**. Intuit says to add an agency only once state registration is final. (https://quickbooks.intuit.com/learn-support/en-us/help-article/sales-taxes/set-collect-sales-tax-quickbooks-online/L1Nu6wYj7_US_en_US)
- **Accounts.** Each agency automatically gets its own "<Agency> Payable" account (Other Current Liability), plus an "Out of Scope Agency Payable" account. AST chooses the agency, and apps can't override that choice. (https://www.teachucomp.com/?p=35687)
- **Custom rates.** Two kinds: **Single** (one rate, one agency) and **Combined** (component rates, each with its own agency, reported separately). They cover cases such as meals, lodging, excise, foreign sales and flat-rate states. Restrictions: **one custom rate per transaction**; editing a rate that has been used makes it inactive and creates a new one; inactive rates can never be reactivated. (https://quickbooks.intuit.com/learn-support/en-us/help-article/set-sales-taxes/use-custom-rates-manually-calculate-taxes-invoices/L8Gt91yR4_US_en_US)

### 3.3 Sales Tax Center
- **Filings tab.** One row per agency per period, showing the amount, due date and status. Actions: *Prepare return / Review sales tax*, *Pre-file check*, *View return*, *Record payment* and exception details.
- **Return review.** Shows gross sales, non-taxable sales, taxable sales, tax, adjustments and balance due, with links to *+ Add an adjustment* and the liability report. Journal entries posted directly to an agency's payable account change its balance due. (https://quickbooks.intuit.com/learn-support/en-us/help-article/pay-sales-taxes/file-sales-tax-return-record-tax-payment-online/L7ZeSlAr1_US_en_US)
- **Adjustments.** Reasons: credit, discount (e.g. a timely-filing discount), prepayment, prior prepayment, penalty/fine, interest, rounding/other. Each needs an offset account: income for credits and discounts, expense for penalties and interest, never the payable account. Amounts can be positive or negative. (https://quickbooks.intuit.com/community/Help-Articles/Create-or-delete-a-sales-tax-adjustment/m-p/300650)
- **Payments.** Recorded with amount, date and bank account. A payment **can't be edited**, only deleted and entered again. (https://quickbooks.intuit.com/learn-support/en-us/sales-taxes/manage-sales-tax-payments/00/185972)
- **Exceptions.** If a transaction in a period already filed is added, edited or deleted, the next return shows an *Exception amount* with a detail list. There are **no amended returns**; the difference rolls into the next return. (https://quickbooks.intuit.com/learn-support/en-ca/help-article/sales-taxes/sales-tax-exceptions/L0WmasjOq_CA_en_CA)
- **Economic nexus page.** Per state it shows:
  - the measurement window (prior 365 days, or the current or prior calendar year, depending on the state)
  - sales as the state defines them (gross, retail or taxable)
  - transaction count
  - a red "threshold met" flag and a green "agency set up" tick
  - when the figures were last updated

  It counts sales only. Physical presence (warehouses, employees, FBA stock) isn't tracked. (https://quickbooks.intuit.com/learn-support/en-us/help-article/taxation/nexus-tax-obligation-another-state/L9ZF0FvLb_US_en_US)

### 3.4 Reports
- **Sales Tax Liability.** Rows per agency, then per jurisdiction level (state, county, city, district). Columns: Gross total, Non-taxable, Taxable, Tax amount. Only the Tax amount column adds up across levels. It includes invoices, sales receipts, credit memos and refund receipts only; **bank deposits and journal entries are excluded**. (https://quickbooks.intuit.com/learn-support/en-us/help-article/sales-taxes/understand-sales-tax-liability-report-quickbooks/L3wP24Uyb_US_en_US)
- Also: Taxable Sales Summary/Detail, Transaction Detail by Tax Code, and exception details.

### 3.5 Filing, e-file and AI (2025–2026)
- **E-file** needs a separate **Sales Tax Essentials** subscription; Intuit doesn't publish the price. Coverage is **19 states**: AR, IN, IA, OH, KY, MI, MN, NE, NV, NJ, NC, ND, PA, RI, SD, TX, VT, WV, WI. Rules:
  - monthly or quarterly returns only (Iowa and Ohio monthly only)
  - payment by ACH debit only
  - "without any adjustments", so no credits or prepayments
  - the user enters the state account ID and EIN; figures auto-fill from the liability report; an optional use-tax line is available
  - status arrives by email
  - the payment is still recorded by hand afterwards

  (https://quickbooks.intuit.com/learn-support/en-us/help-article/state-taxes/faq-filing-taxes/L7id93G7F_US_en_US) Intuit had offered e-file before (six states at $40 per filing from 2018) and shut it down in April 2020. (https://insightfulaccountant.com/accounting-tech/general-ledger/quickbooks-online-sales-tax-e-file-discontinued)
- **Sales Tax AI Agent (beta, Plus and Advanced).** A *Pre-file check* compares P&L income with the return's net sales for the period and lists the transactions behind any difference: missing tax rates, income posted to expense accounts and the reverse. It suggests fixes but never changes data. (https://quickbooks.intuit.com/learn-support/en-ca/help-article/tax-return/review-sales-tax-return-sales-tax-ai-agent-beta/L6d9pdPzC_CA_en_CA)

### 3.6 API model
- **Preferences.** `Preferences.TaxPrefs.UsingSalesTax`, plus `PartnerTaxEnabled`: absent means not an AST company, false means AST but not set up, true means AST and set up.
- **Entities.** `TaxAgency`; `TaxRate` (`RateValue`, `AgencyRef`); `TaxCode` (lists of rates, `TaxGroup`, and `TaxCodeConfigType` SYSTEM_GENERATED vs USER_DEFINED from minor version 51); `TaxService/Taxcode` creates a code and its rates in one call, for custom rates.
- **Transactions.** Lines carry `TaxCodeRef` = `TAX`/`NON`. The header carries `TxnTaxDetail { TxnTaxCodeRef, TotalTax, TaxLine[ TaxLineDetail { TaxRateRef, PercentBased, TaxPercent, NetAmountTaxable } ] }`.
- **Customers.** `Taxable`, `DefaultTaxCodeRef`, `TaxExemptionReasonId`.
- **Overrides.** AST replaces any tax code the app sends. Sending `TotalTax` overrides the amount, which is then prorated across the AST rates. From minor version 70 a supplied `TxnTaxCodeRef` is honoured. Tax-inclusive `GlobalTaxCalculation` throws an error for US companies. Sandbox companies historically don't run AST.
- **Outside QBO.** A separate GraphQL Sales Tax API (`indirectTaxCalculateSaleTransactionTax`, taking ship-from and ship-to) calculates tax for transactions created elsewhere.

(https://developer.intuit.com/app/developer/qbo/docs/workflows/calculate-sales-tax/automated-sales-tax-for-us-locales ; https://blogs.intuit.com/2017/12/11/using-quickbooks-online-api-automated-sales-tax/ ; https://developer.intuit.com/app/developer/qbo/docs/workflows/calculate-sales-tax/sales-tax-use-cases)

### 3.7 Avalara and complaints
- **Avalara AvaTax for QBO.** Maps items to Avalara tax codes, calculates when a transaction is saved and writes the tax back into QBO. Avalara Returns files and remits. Its exemption certificate management (ECM) collects certificates through CertExpress links, applies each state's expiry rules and only exempts a sale when a valid certificate is on file. TaxCloud, Zamp, Commenda and Kintsugi all sell the same pitch: QBO calculates, but leaves nexus, certificates and filing to you. (https://www.avalara.com/us/en/products/integrations/quickbooks/quickbooks-online.html)
- **Complaints:**
  - AST can't be switched off
  - overrides are lost when an invoice is edited
  - stale customer addresses pull in the wrong agencies
  - exempt customers are still charged tax
  - wrong rates after 1 January rate changes
  - phantom prior-period filings after moving to AST
  - marketplace tax posted to the wrong state's payable
  - no amended returns

  (https://quickbooks.intuit.com/learn-support/en-us/taxes/sales-tax-by-location-of-sale/00/1457557 ; https://quickbooks.intuit.com/community/taxes-8/sales-tax-calculating-incorrectly-since-mid-jan-2022-15888)

**Copy:**
- the per-jurisdiction breakdown on every document
- agency as a first-class object with its own payable account, frequency, start date and cash/accrual basis
- returns built from a snapshot of the liability report, plus typed adjustments that each require an offset account
- a list of changes made to filed periods
- a nexus page with per-state measurement windows and transaction counts
- exemption reason codes
- a pre-file check that compares the return to the P&L

**Beat:**
- line-level taxability, so one invoice can mix categories
- shipping taxability that follows each state's rules
- a visible item-category column and a report of it
- an exemption-certificate store (number, state, expiry, file) that stops exempting a customer once the certificate has expired
- overrides that stay locked when the invoice is edited
- amended returns per period
- several ship-from locations, for origin states
- a nexus view that also counts physical presence

## 4. 1099 workflow

- **Vendor.** The vendor record has a "Track payments for 1099" checkbox (off by default) and a "Business ID No." field for SSN or EIN. In the API these are `Vendor1099` and `TaxIdentifier`, with responses masking all but the last four digits. There's no API for box mapping or filing. (https://quickbooks.intuit.com/community/employees-and-payroll-2/is-the-business-id-no-in-the-vendor-section-the-same-as-ein-or-tax-id-9332)
- **W-9 self-onboarding.** "Add a contractor" emails an invitation. The contractor creates a free Intuit account and fills in the W-9 online (bank details for direct deposit are optional). The W-9 data and the signed PDF land on the vendor record, and later edits by the contractor sync back. Status icons show W-9 on file, invited, or not invited. Contractors later see their 1099 in the same account. (https://insightfulaccountant.com/accounting-tech/general-ledger/new-qbo-contractor-w-9-self-set-up)
- **Box mapping.** Done company-wide by expense account. Boxes include NEC box 1, plus MISC rents, royalties, other income, medical payments, attorney gross proceeds and federal tax withheld. **One account can feed only one box**, and an account can be set to "Omit these payments from 1099". Mixed-use accounts have to be split. (https://quickbooks.intuit.com/learn-support/en-us/taxes/1099-nec-mapping/00/1191089)
- **How amounts are counted.** Payments made in the calendar year, using the expense accounts on the payment, or for bill payments the account lines of the underlying bill. (https://quickbooks.intuit.com/learn-support/en-us/help-article/electronic-tax-filing/fix-missing-contractors-wrong-amounts-1099s/L0MspaDKN_US_en_US)
- **Exclusions.** Credit card, debit card and PayPal payments are excluded because they're reported on 1099-K. The exclusion works when the payment comes from a **Credit Card-type account**, not when "Credit card" is chosen as the payment method. It also works when Ref/Check no. contains a keyword: Debit, DBT, DCard, Visa, MC, Masterc, Chase, Discover, Diners, Paypal. (https://quickbooks.intuit.com/learn-support/en-us/help-article/form-1099-nec/payments-excluded-1099-nec-1099-misc/L8bOWEWEs_US_en_US)
- **Wizard** (Expenses & Bills > 1099s):
  1. Company info: legal name, address, EIN.
  2. Categorise payments: map accounts to boxes.
  3. Review contractors: name, address, TIN, email.
  4. "Check that the payments add up": filters for meets threshold, below threshold and non-reportable, with a drill-down to *1099 Transaction Detail*.
  5. E-file, with copies e-delivered or printed and mailed, or print your own forms.

  Only the most recently closed tax year can be prepared. E-file is mandatory at 10 or more information returns. (https://quickbooks.intuit.com/learn-support/en-us/1099-misc-payroll-forms/prepare-and-file-1099s/00/185823)
- **Automated 1099** (announced November 2024; included for QBO Accountant firms, an add-on for everyone else). It:
  - scans transactions to find 1099 vendors
  - excludes corporations and payees under the threshold
  - proposes box assignments, which the user can edit
  - flags card payments
  - sends bulk W-9 requests to recipients with missing tax info
  - files federally and through the **Combined Federal/State (CF/SF) program**, choosing the state from the contractor's address
  - mails paper copies
  - allows unlimited corrections

  There's no TIN matching. (https://www.firmofthefuture.com/product-update/quickbooks-automated-1099/)
- **Pricing.**
  - E-file is bundled with Contractor Payments ($25/month for 20 contractors, then $2 each), Payroll/Workforce, and Bill Pay Premium/Elite. Older per-form prices were $14.99 for three forms plus $3.99 each, and $4.99 per form in 2023.
  - Printing and mailing recipient copies costs about $4 per form (2025).
  - Roughly eight states that require direct filing (e.g. DE, DC, KS, ME, MA, OR, VT, and MI for NEC) need manual filing.

  (https://quickbooks.intuit.com/payroll/1099-efile/ ; https://quickbooks.intuit.com/learn-support/en-us/taxes/re-1099s/01/1597430)
- **Reports.** 1099 Transaction Detail (filter by box, contractor type, threshold), 1099 Contractor Balance Summary and Detail. These reports omit TIN and address, so users merge them with the Vendor Contact List. (https://community.intuit.com/articles/1772329-how-to-create-1099-summary-or-detail-reports)
- **2026 threshold.** OBBBA raised the 1099-NEC/MISC threshold from **$600 to $2,000 for payments made in 2026** (filed in early 2027), indexed for inflation from 2027. Payments made in 2025 still used $600. Backup withholding follows the new figure. 1099-K went back to $20,000 and 200 transactions. Intuit's guide says Bill Pay "automatically tracks payments against the new $2,000 threshold", but older help articles still say $600. Deadline for recipient copies: 1 February 2027. (https://quickbooks.intuit.com/r/taxes/small-business-guide-to-1099-form/ ; https://www.patriotsoftware.com/blog/accounting/1099-reporting-threshold/)

**Copy:**
- the vendor 1099 flag, TIN and W-9 status, with self-service W-9 collection that writes back to the vendor and keeps the signed PDF
- account-to-box mapping with an omit option
- automatic card exclusion based on the type of the paying account
- a threshold-aware review screen with drill-down
- correction tracking per form

**Beat:**
- let a line or transaction override its box, defaulting from the account
- use a real payment-channel field instead of keyword hacks
- check TIN format, and later IRS TIN matching
- store thresholds per tax year, per box and per state as data
- put TIN and address on the 1099 summary report

## 5. Dimensions and tracking

- **Classes** (Plus and up). Can be assigned to the whole transaction or to each line, with an optional warning when a class is missing. Classes can be nested. (https://quickbooks.intuit.com/learn-support/en-ca/help-article/class-list/track-transactions-class/L927QQfNV_CA_en_CA)
- **Locations** (Plus and up). The label can be renamed (Business, Department, Division, Property, Store, Territory). One location per document; the API calls them `Department`. Classes and locations share a cap of **40 on Plus** (unlimited on Advanced). (https://quickbooks.intuit.com/learn-support/en-us/help-article/intuit-subscriptions/learn-usage-limits-quickbooks-online/L6THMltE4_US_en_US)
- **Sub-customers and Projects.** Sub-customers can nest and can be billed with their parent. A project is a single-level sub-customer with a dashboard and reports: Project Profitability (a P&L for the project), Unbilled Time & Expenses, and Non-billable Time. There are no sub-projects. (https://insightfulaccountant.com/accounting-tech/general-ledger/qbo-monday-minute-projects-in-quickbooks-online/)
- **Tags** were retired on 16 May 2025. A converter moved up to 100 tags into custom fields; history stays reportable. Advanced has 12 custom fields that reports can use. (https://insightfulaccountant.com/accounting-tech/general-ledger/important-reminder-qbo-to-stop-supporting-tags/)
- **Intuit Enterprise Suite** offers up to 20 custom line-level dimensions, unlimited values, 5 hierarchy levels, and budgets by dimension. (https://www.fourlane.com/intuit-enterprise-suite-dimensions-explained/)
- **Budgets** (Plus and up). P&L only, monthly/quarterly/yearly, can be prefilled from actuals, subdivided by class, location or customer. Reports: Budget Overview and Budget vs. Actuals. (https://quickbooks.intuit.com/learn-support/en-uk/help-article/class-list/set-budget-targets-class/L9IHc4ite_GB_en_GB)

**Copy:** a renamable location label, a warning when a dimension is missing, budgets split by a dimension, project profitability as a filtered P&L. **Beat:** use generic line-level dimensions from the start, with no caps and no tier gating.

## 6. Banking

- **Feeds and review.** Nightly downloads (around 10 pm PT) with retries, plus manual refresh; 90 days of history on connect, file upload for older data. Items move through *For review*, *Categorized* and *Excluded*, and each can be Added (with splits and dimensions), Matched to existing transactions or open invoices/bills, Excluded, or Undone. (https://community.intuit.com/articles/1145508 ; https://fitsmallbusiness.com/quickbooks-bank-feeds/)
- **Rules.** Conditions on description, bank text, amount and direction. Actions set payee, category, class, location and memo, and can split by % or amount. Rules run in priority order. *Auto-add* posts without review but only works when fewer than 300 items are pending. Rules can be exported. (https://quickbooks.intuit.com/learn-support/en-us/banking/how-to-set-and-use-banking-rules-for-downloaded-transactions/00/262188)
- **Reconciliation.** Enter the statement end date and balance (plus service charge/interest) and tick items to a $0 difference; statuses are blank, C and R. A saved report lists cleared and uncleared items and later changes, and a forced difference posts to *Reconciliation Discrepancies*. **Only QBO Accountant users can undo a reconciliation**, which also undoes all later ones and deletes attachments. (https://quickbooks.intuit.com/learn-support/en-us/help-articles/avoid-undoing-a-reconciliation/00/261414)
- **Checks.** Checks saved with "Print later" join a queue, and check numbers are assigned when they print. Layouts are Voucher (one check plus stubs per page) and Standard (three per page); wallet stock is poorly supported. Alignment uses a test print and a drag grid. Failed prints go back into the queue. (https://quickbooks.intuit.com/learn-support/en-us/help-article/print-file/print-check-quickbooks-online/L0z74QkU3_US_en_US)
- **Positive Pay.** There's no native file. Banks tell customers to export the check register or a report to CSV, or to buy an add-on. (https://www.securityfederalbank.com/assets/files/sA7cbtJp)
- **Bill Pay.** Intuit's own product since the Melio integration ended in May 2024. Basic is $0 (5 free ACH a month), Premium $15 (40 ACH, unlimited 1099s), Elite $90 (unlimited ACH, approval workflows); checks cost $1.50. (https://quickbooks.intuit.com/bill-pay/) **QuickBooks Payments:** about 2.5–3.5% for cards and 1% for ACH (uncapped on newer accounts); deposits and fees post automatically. (https://dodopayments.com/blogs/quickbooks-payments-fees/)

**Copy:** the review tabs and actions, rules with splits and auto-add, reconciliation by statement date and balance with a saved report, a check print queue that assigns numbers at print time, processor deposits split into gross, fees and net. **Beat:** let admins undo the latest reconciliation, with an audit log entry; add a Positive Pay export; refresh feeds more often than nightly.

## 7. Reports and accountant tools

- **Report catalogue** (gated by plan): P&L (standard, Detail, by Month, Comparison, by Customer, by Class/Location on Plus); Balance Sheet (standard, Detail, Comparison); Statement of Cash Flows (indirect; classification follows account type); Budget vs. Actuals; A/R and A/P aging (current, 1–30, 31–60, 61–90, 91+); 1099 and sales tax reports; and "for my accountant": General Ledger, Journal, Trial Balance, Transaction Detail by Account, voided/deleted, Exceptions to Closing Date, reconciliation reports. Every report has a cash/accrual toggle, grouping by dimension, saved custom versions and scheduled email. Advanced adds a Custom Report Builder. (https://quickbooks.intuit.com/learn-support/en-us/help-article/purchase-orders/reports-included-quickbooks-online-subscription/L0s4KrGgr_US_en_US)
- **Audit log.** Covers sign-ins, settings, lists and transactions, filterable by user, date and event, with a per-transaction history. Actions by the system and by Intuit support are labelled as such. It can't be turned off and is kept for 2 years. (https://quickbooks.intuit.com/learn-support/en-us/help-article/audit-log/use-audit-log-quickbooks-online/L2WoVnW6I_US_en_US)
- **Accountant tools** (QBO Accountant): bulk **Reclassify transactions** (account or class/location, ignoring the closing date); **Write off invoices** filtered by age (over 180 days, over 120 days, custom) to a chosen account; **adjusting journal entries**, flagged and shown separately in the working trial balance; a voided/deleted view; **Prep for taxes** (this year vs. last year trial balance, adjusting entries, tax mapping, export). (https://quickbooks.intuit.com/community/help-articles-128/use-accountant-tools-and-features-in-quickbooks-online-accountant-284571)

**Copy:** the aging buckets, the cash/accrual toggle on every report, an adjusting-entry flag, bulk reclassify, invoice write-off by age. **Beat:** reclassify should respect locked periods unless an override is logged; keep the full audit history rather than 2 years; let users map accounts into the cash flow statement.

## 8. Payroll

- **QuickBooks Payroll** comes in Core, Premium and Elite. It calculates withholding; files and pays federal (941/940) and state returns; prepares W-2s; and pays by direct deposit (next-day on Core, same-day on Premium and Elite). Elite adds tax penalty protection. Prices went up in 2025 and again for renewals from August 2026. (https://tech.co/hr-software/quickbooks-payroll-pricing)
- **How payroll posts.** Each paycheck debits *Payroll Expenses: Wages* and *: Taxes*, credits *Payroll Liabilities* sub-accounts (federal 941, FUTA, state SUI/withholding, deductions), and posts net pay to the bank or Direct Deposit Payable; tax payments clear the liabilities. Payroll Settings > Accounting maps each item to an account, can rewrite past transactions from a start date, and can split by class or location. (https://quickbooks.intuit.com/learn-support/en-us/help-article/payroll-preferences/payroll-accounting-preferences/L5k2c4hVh_US_en_US)
- **Third-party payroll.** Gusto, ADP, Paychex and others post a **summarised journal entry per pay run** through the API. The mapping screen lives in the provider's app. Net pay often goes to a "<Provider> Clearing" account. If the provider remits the taxes, liabilities are sometimes mapped straight to the bank. (https://support.gusto.com/article/100971895100000/Integrate-with-quickbooks-online ; https://support.adp.com/adp_payroll/content/hybrid/GL/Offline-Infographic-GL-Mapping.pdf)

**Copy:** define a payroll-journal import contract per pay run (expense lines, liabilities per agency, net-pay clearing, optional dimensions), a mapping UI, and liability accounts that reconcile to zero.

## 9. Other features

- **Inventory** (Plus and up). Perpetual, **FIFO only**. Inventory Valuation reports. Multiple locations only on Advanced or Intuit Enterprise Suite. (https://www.digit-software.com/blog/quickbooks-inventory-management)
- **Purchase orders** (Plus and up). An estimate can be copied to a PO, but rate, customer and class don't carry over (2025). (https://quickbooks.intuit.com/learn-support/en-us/help-article/new-subscriptions/copy-estimate-purchase-order/L7Z08es7a_US_en_US)
- **Progress invoicing** (all plans). Invoice the full estimate, a % of each line, or a custom amount per line. QBO tracks what has been billed, and the last invoice bills the remainder. (https://www.nerdwallet.com/business/software/learn/quickbooks-progress-invoicing)
- **Multicurrency.** Can't be turned off; the home currency can't be changed. Each customer, vendor and account has one currency. Exchange rates update automatically, and open balances are revalued with a home-currency adjustment. QuickBooks Payments works in the home currency only. (https://quickbooks.intuit.com/learn-support/en-us/help-articles/how-multi-currency-works/00/261377)
- **Fixed assets.** Advanced only, added around 2023–24. An asset register with straight-line, 150% or double-declining depreciation, posted automatically each month, plus disposals and import. Book depreciation only: no MACRS or Section 179 book. Lower tiers have nothing. (https://blog.insightfulaccountant.com/more-about-the-qbo-advanced-fixed-asset-feature)
- **Revenue recognition** (Advanced). A template on the item plus a deferred revenue account; the service date on the invoice starts the schedule; recognition entries post monthly; changes recalculate the schedule. No ASC 606 allocation across elements. (https://insightfulaccountant.com/accounting-tech/general-ledger/qbo-monday-minute-revenue-recognition-feature-in-quickbooks-online-advanced/)
- **Plans** (renewals from 1 August 2026): Simple Start $38, Essentials $85, Plus $140, Advanced $340 per month. (https://www.certumsolutions.com/library/quickbooks-price-increase-august-2026)

## 10. Complaints and gaps to target

1. **Sales tax gaps** (section 3.7): no certificates, no amended returns, overrides lost, sales-only nexus, e-file in only 19 states behind a paid add-on, no category report.
2. **Tier gating and caps:** classes, locations, projects, budgets, inventory and POs need Plus; fixed assets, revenue recognition, custom roles and the report builder need Advanced; 250 accounts and 40 classes+locations below Advanced. 2026 renewals rose about 13–24%. (https://www.fourlane.com/quickbooks-online-pricing-changes-2026-new-rates-and-fourlane-discounts/)
3. **Controls accountants don't like:** a single closing date, reconciliation undo for accountants only, a 2-year audit log, reclassify that ignores locks, reports that end up exported to Excel. (https://quickbooks.intuit.com/community/reports-and-accounting-5/i-hate-quickbooks-complaints-49122)
4. **Bank feeds:** duplicates after file uploads or manual refreshes; nightly-only updates. (https://quickbooks.intuit.com/community/banking-4/duplicate-transactions-from-bank-feed-31700)
5. **Product churn:** Tags retired, the Melio bill pay integration removed, e-file shut down and later relaunched, UI changes users can't opt out of, irreversible settings (multicurrency, AST).
6. **AI:** in July 2025 Intuit launched an Accounting agent (categorisation and reconciliation matching), a Payments agent (late-payment prediction, reminders), a Finance agent (KPIs, forecasts) and a Customer agent, followed by the Sales Tax AI agent (beta) and, according to third parties, a Payroll agent. All of them draft or suggest; a person approves. WeldBooks can match this approach: explained suggestions with an audit trail, never silent posting. (https://www.cpapracticeadvisor.com/2025/06/27/intuit-rolls-out-ai-agents-for-quickbooks/163868/)

## Data model for WeldBooks, as implied by the above (descriptive, no code)

- **Sales tax:**
  - Agency: state, registration ID, filing frequency, start date, cash/accrual basis, payable account.
  - Jurisdiction rate: level, agency, rate, effective dates.
  - Taxability category on items, with per-state rules.
  - Customer exemption: reason, state, certificate number, expiry, document.
  - Line-level tax breakdown, with a locked override.
  - Return: agency, period, liability snapshot, typed adjustments with offset accounts, payment, status, amendment.
  - Nexus tracker: per-state threshold rule and measurement window.
- **1099:**
  - Vendor profile: flag, TIN and TIN type, W-9 status and document.
  - Box mapping: default from the account, overridable per line.
  - Thresholds stored per tax year, box and state.
  - Filed forms, each with its corrections.
