# US accounting research for WeldBooks

Research done 7–8 October 2026 for [the US plan](../weldbooks-us.md). Each file
cites its sources inline and ends with a list of items it could not verify for
2026; check those before building on them.

| File | Covers |
|---|---|
| [federal.md](federal.md) | GAAP vs tax and cash basis, IRS accounting methods and tax years, entity types and their returns, tax-line catalogs (Schedule C, 1065, 1120-S, 1120), depreciation after the One Big Beautiful Bill Act, 1099 rules and the move from FIRE to IRIS, record keeping, other business taxes, payroll's ledger impact, checks / ACH (Nacha) / routing numbers / US statement formats, e-invoicing, localization basics |
| [sales-tax.md](sales-tax.md) | State and local sales and use tax: nexus (with a state-by-state economic nexus table), jurisdictions and rate data sources, sourcing (origin vs destination), taxability (with a SaaS table), exemptions, calculation and rounding, filing, use tax, penalties, and a tax-engine provider comparison |
| [quickbooks.md](quickbooks.md) | How QuickBooks Online (US) handles company setup, chart of accounts, automated sales tax and the Sales Tax Center, 1099s, dimensions, banking, reports, payroll; what to copy and what to beat |
| [odoo.md](odoo.md) | Odoo 17/18/19 US localization: modules, the tax and fiscal-position data model, AvaTax, checks, NACHA, 1099, lock dates, bank sync; trade-offs |
| [bank-feeds.md](bank-feeds.md) | Stripe Financial Connections vs Plaid, other US and EU aggregators, CFPB §1033 status, a normalized data model for `@weldsuite/bank-feeds` |

## The US rules in brief

**No VAT.** The US has no national sales tax and no VAT. 45 states and DC levy
a sales tax on the final sale to the consumer; there is no input-tax credit, so
tax a business pays on its own purchases is part of the cost. When a vendor
doesn't charge it, the buyer owes use tax instead.

**Sales tax is local.** About 12,600 jurisdictions (state, county, city,
special districts) with roughly 400+ rate changes every six months, mostly at
quarter starts. A rate is the sum of its components, and returns report per
jurisdiction. Five-digit ZIP codes cross jurisdiction lines, so ZIP-level rates
are often wrong; address-level (ZIP+4 or geocoded) lookups are the norm.
Illinois charges a 15% rate on destination sales it can't place.

**Collect only where there's nexus.** Physical presence (an office, an
employee, inventory in a warehouse or Amazon FBA) or economic nexus, usually
$100,000 of sales into the state in a year ($500,000 in CA, TX, NY; $250,000 in
AL, MS). The 200-transaction test is disappearing (Illinois dropped it on 1
January 2026, Kentucky on 1 August 2026). Each state defines its own base
(gross, retail or taxable sales), measurement window and whether marketplace
sales count. Marketplaces (Amazon, Etsy) collect on the sales they facilitate.

**Origin vs destination.** Interstate sales are always taxed at the
destination. For in-state sales, AZ, CA (partly), IL, MS, MO, OH, TN, TX, UT
and VA tax at the seller's location; New Mexico and (for local tax)
Pennsylvania moved to destination.

**Taxability varies by state.** Goods are taxable unless exempt (groceries,
clothing and prescription drugs vary). Services are mostly exempt unless listed
(HI, NM, SD, WV tax most of them). SaaS is taxable in roughly half the states,
sometimes only for business buyers or on part of the price (Texas: 80%), and
changes often: California and Colorado start taxing SaaS on 1 January 2027.
Shipping is taxable in some states and exempt when separately stated in others.

**Exemptions need certificates.** Resale, nonprofit, government and similar
exemptions are documented with a certificate per state (SST form F0003, the MTC
uniform certificate or the state's own form), each with its own validity rules.
Exempt sales still appear on the return as gross sales with a deduction.

**Rounding.** The Streamlined Sales Tax rule: compute to three decimals and
round half-up to the cent, per line or per invoice at the seller's choice.

**Returns.** One per registration (state, plus self-administered local
agencies in CO, AL, LA, AK), monthly / quarterly / annual as the state
assigns, usually due on the 20th of the following month. Zero returns are still
due. About half the states let the seller keep a small timely-filing discount.

**Federal income tax.** Sole proprietors file Schedule C, partnerships 1065,
S corps 1120-S, C corps 1120, nonprofits the 990 series. Most small businesses
keep accrual books but file on the cash method (allowed below $32M average
gross receipts for 2026). Accounting software maps accounts to tax-return lines
and reports on both bases.

**1099s.** Businesses report payments to contractors and other payees on 1099-NEC
and 1099-MISC. For payments made in 2026 the threshold is $2,000 (up from
$600), indexed from 2027; royalties stay at $10 and attorney gross proceeds at
$600. Payments by card or PayPal are excluded (the processor files a 1099-K).
Corporations are exempt except law firms and medical providers. Forms are due 31
January; filing 10 or more returns requires e-filing, which from the 2026 tax
year goes through IRIS (FIRE closes 19 November 2026). A missing TIN means 24%
backup withholding.

**Records.** Keep records 3 to 7 years with an audit trail from the return back
to each transaction (Rev. Proc. 98-25). No statutory chart of accounts and no
mandated invoice format; no US e-invoicing mandate.

**Banking.** Routing (ABA) plus account numbers, ACH payments in Nacha files,
paper checks with a MICR line and Positive Pay, OFX/QFX/QBO statement files.
Bank feeds come from aggregators (Plaid, Stripe Financial Connections, MX,
Finicity, Yodlee, Teller).
