# US State and Local Sales and Use Tax: research for WeldBooks

Research date: 2026-10-07/08. Status: COMPLETE (web-search budget ran out near the end; items not re-verified are listed in section 12).

**Where the requested deliverables are:** (a) economic-nexus table = 2.3; (b) origin vs destination = 4.2; (c) SaaS/digital table = 5.2; (d) provider comparison = 3.6; (e) "what the software must do" = 11; (f) uncertain list = 12.

**Key findings for the design**
- 45 states + DC tax sales; about 12,600 jurisdictions (Vertex, June 2026) and 400+ rate changes every half year, so rates must be effective-dated and computed per jurisdiction component.
- Economic nexus is now mostly a $100,000 sales test (CA, TX, NY at $500,000; AL, MS at $250,000). Illinois (Jan 1, 2026) and Kentucky (Aug 1, 2026) dropped the 200-transaction test; 14 states plus DC still use it on an OR basis, CT and NY on an AND basis. Base, window and marketplace inclusion differ per state.
- 2026-2027 law changes to encode: Pennsylvania local tax becomes destination-sourced (enforced Oct 1, 2026); Chicago's SaaS lease tax is 15% (Jan 1, 2026); California (SB 122) and Colorado (HB 26-1223) tax SaaS from Jan 1, 2027; Washington's 2025 services expansion is mostly repealed from 2029; Maryland's 3% IT/SaaS rate (Jul 2025).
- Free official data covers only part of the country (24 SST states' quarterly rate/boundary files, plus WA, CA and TX tools); anything multi-state realistically needs a provider. Every serious provider supports per-customer credentials. Stripe Tax's calculations-only API ($0.05/call) is the lowest-friction broad option; Avalara, Sovos and TaxCloud are the SST Certified Service Providers that can file for free in SST states.

Scope: US state and local sales and use tax only (no income/franchise tax). Facts were checked against primary sources where reachable (state DORs, streamlinedsalestax.org, mtc.gov, Stripe docs) and cross-checked against trackers (Sales Tax Institute, Avalara, Tax Foundation, Vertex, TaxCloud, Kintsugi). Vendor blogs are flagged where they are the only source.

---

## 1. Fundamentals

- **Sales tax** is imposed on retail sales of tangible personal property (TPP) and enumerated services; the seller collects it from the buyer and remits it. **Use tax** is the complement: it is due on taxable items used, stored or consumed in a state when sales tax was not charged (typically a remote/out-of-state purchase). Rates are normally identical, so a registered remote seller collects "seller's use tax" and an in-state seller collects sales tax; a buyer self-assesses use tax when the vendor did not collect.
- **Coverage.** 45 states plus DC levy a statewide sales tax; 38 states allow local sales taxes (including Alaska, which has none at state level). Nationwide population-weighted average combined rate 7.53% at July 1, 2026; highest combined averages Louisiana 10.13%, Tennessee 9.61%, Washington 9.57%, Arkansas 9.48%, Alabama 9.46%. No statewide rate changed between Jan and Jul 2026; all movement was local. (Tax Foundation midyear 2026: https://taxfoundation.org/data/all/state/2026-sales-tax-rates-midyear/)
- **Recent state-level changes worth encoding:** Louisiana state rate 4.45% -> 5% from Jan 1, 2025; Illinois repealed its 1% state grocery tax from Jan 1, 2026 (many localities imposed their own 1% grocery tax); New Mexico GRT 4.875% with a trigger back to 5.125% if receipts fall; South Dakota's 4.2% rate is scheduled to sunset in June 2027. (same Tax Foundation page)
- **NOMAD states (no statewide sales tax): New Hampshire, Oregon, Montana, Alaska, Delaware.**
  - *New Hampshire*: no general sales tax, but a Meals and Rooms (Rentals) tax applies to prepared meals, room rentals and motor vehicle rentals.
  - *Oregon*: no sales tax; the Corporate Activity Tax is a gross-receipts tax on the seller, not a collected tax.
  - *Montana*: no general sales tax; resort-area local taxes and lodging taxes exist (Tax Foundation excludes resort taxes from its rankings).
  - *Delaware*: no sales tax; the seller pays a gross receipts tax that is not a line-item tax on the invoice.
  - *Alaska*: no state tax, but roughly 100+ boroughs/cities levy local sales taxes (average 1.82%, max 7.85% per Tax Foundation). Remote sellers deal with the **Alaska Remote Seller Sales Tax Commission (ARSSTC)**, which administers a Uniform Code for member municipalities (the ARSSTC Q1-2026 update lists about 55 jurisdiction entries; Anchorage participates only for its alcohol tax). Threshold $100,000 gross sales (transaction test removed Jan 1, 2025), destination sourced, monthly filing through the ARSSTC portal (MuniRevs); non-member municipalities are filed with directly. (https://arsstc.org/wp-content/uploads/2026/06/ARSSTC-2026Q1-update.pdf ; https://www.avalara.com/blog/en/north-america/2024/11/alaska-removes-economic-nexus-transaction-threshold.html ; https://trykintsugi.com/sales-tax-guides/usa/alaska)
- **Puerto Rico (IVU)** is a US territory with its own sales and use tax: 11.5% combined (10.5% commonwealth + 1% municipal), with a reduced 4% rate on many B2B and designated professional services; economic nexus $100,000 or 200 transactions since Jan 1, 2021. Treat PR as a separate jurisdiction in the engine, not as a 47th state. (https://trykintsugi.com/sales-tax-guides/usa/puerto-rico ; https://www.salestaxinstitute.com/resources/economic-nexus-state-guide). The 4% B2B rate is confirmed only by vendor guides.
- **No input credit.** US sales tax is a single-stage retail tax, not a VAT. Sales tax paid on a business's own purchases is **not recoverable**: it is capitalized into inventory/fixed-asset cost or expensed. Purchases for resale are made tax-free with a resale certificate instead. Collected tax is a liability owed to the taxing agency, never revenue.
- **Consumer use tax.** When a business buys taxable goods or services for its own use without being charged tax (e.g., from an unregistered out-of-state vendor), it must self-assess use tax, on its sales and use tax return if registered, or on a consumer use tax return. See section 9.

---

## 2. Nexus

### 2.1 Physical nexus
Physical presence still creates a collection duty with **no dollar minimum**: an office, store, warehouse, **inventory held by a 3PL or in Amazon FBA/marketplace fulfilment centers**, employees (including a single remote W-2 employee working from home), independent sales reps soliciting in the state, installers/technicians, owned or leased property, and attending trade shows. Several states offer trade-show safe harbors (Illinois: at most two shows per year and under $10,000 of taxable receipts; Georgia: five days or fewer and limited income; California: under 15 days and under $100,000; Massachusetts: more than three days of solicitation creates nexus), but others treat even one day as presence. Inventory in a state is treated as nexus by most states that host fulfilment centers, though Pennsylvania lost a 2022 case on FBA-only inventory. (https://www.taxjar.com/blog/nexus/does-attending-a-trade-show-create-sales-tax-nexus ; https://www.salestaxinstitute.com/resources/sales-tax-nuances-of-trade-show-attendance ; https://taxcloud.com/blog/physical-nexus/)

Engine implication: nexus is a per-state **user-maintained fact** (start date, reason, registration number) plus an economic-nexus monitor; software cannot detect physical presence on its own.

### 2.2 Economic nexus after Wayfair (2018)
*South Dakota v. Wayfair* (June 21, 2018) allowed states to require collection based on sales volume alone. Every one of the 45 sales-tax states plus DC now has an economic nexus rule. The trend is to drop the "200 transactions" test. As of Aug 1, 2026 Avalara counts **17 jurisdictions that have eliminated the transaction test** (AK*, CA, CO, IL, IN, IA, KY, LA, ME, MA, NC, ND, SD, UT, WA, WI, WY) and **13 that never had one** (AL, AZ, FL, ID, KS, MS, MO, NM, OK, PA, SC, TN, TX). (https://www.avalara.com/blog/en/north-america/2025/06/states-eliminating-economic-nexus-transaction-thresholds.html)

**2025-2026 changes verified:**
- **Utah**: 200-transaction test removed effective **July 1, 2025**.
- **Illinois**: 200-transaction test removed effective **Jan 1, 2026** (P.A. 104-0006 / HB 2755). Only test is now $100,000 cumulative gross receipts over the preceding 12 months, reviewed quarterly. The same bulletin says destination-based sales without enough location data are assessed at a punitive **15% "undetermined location" rate**. Illinois also ran a remote-retailer amnesty **Aug 1 to Oct 31, 2026**. (IDOR Informational Bulletin FY 2026-12: https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html ; https://www.avalara.com/blog/en/north-america/2025/06/illinois-drops-transaction-threshold-offers-tax-amnesty.html)
- **Kentucky**: HB 757 (2026) removed the 200-transaction test effective **Aug 1, 2026**; the same bill made **data brokering services** taxable at 6% from Aug 1, 2026. (https://www.avalara.com/blog/en/north-america/2026/04/kentucky-removes-transaction-threshold-taxes-data-brokering-services.html)
- **New Jersey**: bill S711 (2026-27 session) to remove the 200-transaction test was reported out of the Senate Budget committee on June 24, 2026; **not enacted** as of the latest reporting found, so NJ still uses $100,000 OR 200. (https://legiscan.com/NJ/research/S711/2026 ; https://www.anrok.com/tax-news/new-jersey-set-to-drop-200-transactions-sales-tax-rule)
- Earlier removals: South Dakota Jul 1, 2023; Louisiana Aug 1, 2023; Indiana Jan 1, 2024; North Carolina Jul 1, 2024; Wyoming Jul 1, 2024; Alaska (ARSSTC) Jan 1, 2025.

### 2.3 State-by-state economic nexus table (as of Oct 2026)

Primary compilation: Sales Tax Institute "Economic Nexus State by State Chart", labelled "as of 8/1/2026" (https://www.salestaxinstitute.com/resources/economic-nexus-state-guide), updated with the IL/KY changes above and cross-checked against Avalara. "What counts": Gross = all sales into the state incl. exempt and resale; Retail = retail sales (excludes sales for resale) incl. exempt retail sales; Taxable = taxable sales only. "Mkt" = whether sales made through a marketplace facilitator count toward the remote seller's own threshold. CY = calendar year. "OR" = either test triggers; "AND" = both needed.

| State | Sales threshold | Transactions | Measurement period | What counts | Mkt | Effective / notes |
|---|---|---|---|---|---|---|
| Alabama | $250,000 | none | Previous CY | Retail (TPP) | Excl | Oct 1, 2018. Remote sellers may opt into the SSUT flat 8% program |
| Alaska (ARSSTC members) | $100,000 | removed Jan 1, 2025 | Current or previous CY | Gross | Incl | Local only; per adopting municipality |
| Arizona | $100,000 | none | Previous or current CY | Gross | Excl | Oct 1, 2019; stepped $200k (2019), $150k (2020), $100k (2021+) |
| Arkansas | $100,000 | OR 200 | Previous or current CY | Taxable | Excl | Jul 1, 2019 |
| California | $500,000 | none | Preceding or current CY | Gross TPP delivered into CA | Incl | Apr 1, 2019 |
| Colorado | $100,000 | none (removed 2019) | Previous or current CY | Retail | Excl | Dec 1, 2018 (enforced Jun 1, 2019) |
| Connecticut | $100,000 | **AND** 200 | 12 months ending Sep 30 | Retail | Incl | Dec 1, 2018; $100k since Jul 1, 2019 |
| DC | $100,000 | OR 200 | Previous or current CY | Retail | Incl | Jan 1, 2019 |
| Florida | $100,000 | none | Previous CY | Taxable remote sales | Excl | Jul 1, 2021 |
| Georgia | $100,000 | OR 200 | Previous or current CY | Retail | Excl | Jan 1, 2019; $100k since Jan 1, 2020 |
| Hawaii | $100,000 | OR 200 | Current or preceding CY | Gross | Incl | Jul 1, 2018 (GET, a tax on the seller) |
| Idaho | $100,000 | none | Previous or current CY | Gross | Incl | Jun 1, 2019 |
| Illinois | $100,000 | **removed Jan 1, 2026** | Preceding 12 months, tested quarterly | Gross receipts (retail) | Excl | Oct 1, 2018 |
| Indiana | $100,000 | removed Jan 1, 2024 | Current or preceding CY | Gross | Excl | Oct 1, 2018 |
| Iowa | $100,000 | removed 2019 | Current or preceding CY | Gross | Incl | Jan 1, 2019 |
| Kansas | $100,000 | none | Current or preceding CY | Gross | Incl | Jul 1, 2021 |
| Kentucky | $100,000 | **removed Aug 1, 2026** | Previous or current CY | Gross | Incl | Oct 1, 2018 |
| Louisiana | $100,000 | removed Aug 1, 2023 | Previous or current CY | Gross | Incl | Jul 1, 2020; remote sellers can file with the LA Sales and Use Tax Commission for Remote Sellers |
| Maine | $100,000 | removed Jan 1, 2022 | Previous or current CY | Gross | Excl | Jul 1, 2018 |
| Maryland | $100,000 | OR 200 | Previous or current CY | Gross | Incl | Oct 1, 2018 |
| Massachusetts | $100,000 | none | Previous or current CY | Gross | Excl (if facilitator collects) | Oct 1, 2019 (replaced $500k + 100 tx rule of Oct 2017) |
| Michigan | $100,000 | OR 200 | Previous CY | Gross | Incl | Oct 1, 2018 |
| Minnesota | $100,000 | OR 200 retail sales | 12 months ending last day of most recent completed quarter | Retail | Incl | Oct 1, 2018 |
| Mississippi | > $250,000 | none | Prior 12 months | Gross | Excl | Sep 1, 2018 |
| Missouri | $100,000 | none | Previous 12 months, tested quarterly | Taxable | Incl | Jan 1, 2023 (last state to adopt) |
| Nebraska | $100,000 | OR 200 | Previous or current CY | Retail | Incl | Jan 1 / Apr 1, 2019 |
| Nevada | $100,000 | OR 200 | Previous or current CY | Retail | Incl | Nov 1, 2018 |
| New Jersey | $100,000 | OR 200 (repeal bill S711 pending) | Previous or current CY | Gross | Incl | Nov 1, 2018 |
| New Mexico | $100,000 | none | Previous CY | Taxable gross receipts | Excl | Jul 1, 2019 |
| New York | > $500,000 | **AND** > 100 sales | Immediately preceding four sales-tax quarters | Gross receipts from TPP | Incl | Jun 21, 2018; $500k since Jun 24, 2019 |
| North Carolina | $100,000 | removed Jul 1, 2024 | Previous or current CY | Gross | Incl | Nov 1, 2018 |
| North Dakota | $100,000 | removed (periods after 2018) | Previous or current CY | Taxable | Excl | Oct 1, 2018 |
| Ohio | $100,000 | OR 200 | Previous or current CY | Retail | Incl | Aug 1, 2019 (replaced $500k rule of Jan 2018) |
| Oklahoma | $100,000 | none | Preceding or current CY | Taxable | Excl | Nov 1, 2019 |
| Pennsylvania | $100,000 | none | Previous 12 months | Gross (all channels) | Incl | Jul 1, 2019 |
| Rhode Island | $100,000 | OR 200 | Immediately preceding CY | Gross | Incl | Jul 1, 2019 |
| South Carolina | $100,000 | none | Previous or current CY | Gross | Incl | Nov 1, 2018 |
| South Dakota | $100,000 | removed Jul 1, 2023 | Previous or current CY | Gross | Incl | Nov 1, 2018 |
| Tennessee | $100,000 | none | Previous 12 months | Retail | Excl | Oct 1, 2019; $100k since Oct 1, 2020 |
| Texas | $500,000 | none | Preceding 12 calendar months | Gross revenue | Incl | Oct 1, 2019 |
| Utah | $100,000 | **removed Jul 1, 2025** | Previous or current CY | Gross | Excl | Jan 1, 2019 |
| Vermont | $100,000 | OR 200 | Prior four calendar quarters | Gross | Incl | Jul 1, 2018 |
| Virginia | $100,000 | OR 200 | Previous or current CY | Retail | Excl | Jul 1, 2019 |
| Washington | $100,000 | removed 2019 | Current or preceding CY | Gross (B&O "gross income") | Incl | Oct 1, 2018 |
| West Virginia | $100,000 | OR 200 | Preceding or current CY | Gross | Incl | Jan 1, 2019 |
| Wisconsin | $100,000 | removed Feb 20, 2021 | Previous or current CY | Gross | Incl | Oct 1, 2018 |
| Wyoming | $100,000 | removed Jul 1, 2024 | Previous or current CY | Gross | Excl | Feb 1, 2019 |
| *Puerto Rico* | $100,000 | OR 200 | Seller's fiscal year (per STI) | Gross | Excl | Jan 1, 2021 |

Still using a transaction test (Oct 2026): AR, GA, HI, MD, MI, MN, NE, NV, NJ, OH, RI, VT, VA, WV and DC (plus PR) on an OR basis; CT and NY on an AND basis.

Engine notes:
- Thresholds differ in **base** (gross vs retail vs taxable), **window** (prior CY, current CY, rolling 12 months, rolling four quarters, CT's Oct-Sep year) and **marketplace inclusion**. A nexus monitor must store all three per state, not just a dollar figure.
- "When must collection start" also differs (first day of next month, next transaction, 30/60/90 days after crossing; Sales Tax Institute notes North Carolina updated its timing to 60 days in July 2026). Store as per-state rule data; do not hard-code.
- The marketplace-inclusion cells are where trackers most often disagree; treat them as data to verify per state.

### 2.4 Marketplace facilitator laws
All 45 sales-tax states and DC have marketplace facilitator laws (Missouri's, effective Jan 1, 2023, was the last). The facilitator (Amazon, Etsy, eBay, Walmart, etc.) collects and remits on facilitated sales; the third-party seller normally does not collect on those sales but may still need to register (if it has nexus through other channels) and in some states must report facilitated sales as a deduction on its own return. States split on whether facilitated sales count toward the seller's own threshold (see "Mkt" column). (https://www.salestaxinstitute.com/resources/economic-nexus-state-guide ; https://www.avalara.com/us/en/learn/whitepapers/fba-sellers-guide-sales-tax.html)

Engine implication: tag every sale with a `collected_by_marketplace` flag so marketplace sales (a) are excluded from tax calculation, (b) are counted or excluded per state in the nexus monitor, and (c) appear as a "marketplace sales" deduction line where a state's return asks for it.

### 2.5 Voluntary disclosure and amnesty
- **State VDAs**: a seller with past exposure applies (often anonymously) before the state makes contact; typical result is a 3-4 year lookback, waiver of penalties, interest still due. Tax actually collected from customers but not remitted is never limited by the lookback.
- **MTC Multistate Voluntary Disclosure Program** (National Nexus Program): one anonymous application coordinated across participating states; the lookback is measured from the date NNP receives the application; each state sets its own lookback (e.g., Alabama 36 months, Arizona 48 months, Florida 3 years, Wisconsin prior 4 years plus current per MTC's July 2024 chart); applications under $500 estimated tax per state are not processed. (https://www.mtc.gov/nexus/Multistate-Voluntary-Disclosure-Program ; https://mtc.gov/wp-content/uploads/2024/07/Lookback-period-chart-7-17-24.pdf)
- **SST amnesty (SSUTA Sec. 402)**: sellers registering through the Streamlined Sales Tax Registration System (SSTRS) who were not registered in that state in the prior 12 months can get amnesty for uncollected tax, penalty and interest, conditional on staying registered and compliant for 36 months; not available once an audit notice is received. A 2024 proposal to replace it with an SST-wide VDA was not adopted. (https://streamlinedsalestax.org/for-businesses/amnesty ; https://www.salestaxinstitute.com/resources/streamlined-sales-tax-agreement-is-amended-to-revise-amnesty-qualifications)
- **Time-limited amnesties** recur (e.g., Illinois remote-retailer amnesty Aug 1 to Oct 31, 2026).

---

## 3. Rates, jurisdictions and data sources

### 3.1 How many jurisdictions, and how they layer
- Vertex counted **12,566** sales and use tax jurisdictions at June 30, 2026 (7,183 cities, 1,972 counties, 3,365 special districts, 46 states incl. DC), with **463 rate changes in H1 2026** (408 in H1 2025), including 63 new taxing cities and 105 new district taxes. Vendors' marketing figures range 12,000-14,000; "about 13,000" is the usual round number. (https://www.vertexinc.com/resources/resource-library/numbers-us-sales-tax-rates-and-rules-reach-new-highs-2026)
- A combined rate is **state + county + city + one or more special districts** (transit, stadium, library, fire, crime-control, "special purpose districts" in Texas, "district taxes" in California, regional transit in Washington). Each component can have its own taxability exceptions, caps (e.g., Tennessee's local tax applies only to the first $1,600 of a single item, with a state single-article tax above that), and its own reporting code. Stripe's API example for Seattle shows five components: WA state 6.5%, King County 0%, Seattle 2.2%, Regional Transit Authority 1.4%, Seattle Transportation Benefit District 0.15% = 10.25%. (https://docs.stripe.com/tax/custom)
- Engine implication: store and compute **per jurisdiction component**, not one blended rate. SST rate files and NC DOR explicitly say tax is computed for each jurisdiction separately and that returns report per jurisdiction code. (https://www.ncdor.gov/taxes-forms/sales-and-use-tax/other-sales-and-use-tax-resources/streamlined-sales-tax-information/rate-and-boundary-database-information)

### 3.2 Self-administered / home-rule local taxes
- **Colorado**: 70+ home-rule cities can self-collect with their own tax base, licensing and returns, alongside state-collected ("statutory") cities, counties and special districts. The state's **SUTS** (Sales and Use Tax System) portal lets one return cover state-collected and participating home-rule jurisdictions; not every home-rule city participates. HB 24-1041 (signed April 2024) bars home-rule localities that do **not** use SUTS from requiring collection by retailers without in-state physical presence, and lets DOR allow quarterly filing below $600/month tax. State-administered local rate changes take effect only Jan 1 or Jul 1. (https://www.salestaxinstitute.com/resources/colorado-changes-requirements-for-home-rule-jurisdictions-not-using-suts ; https://tax.colorado.gov/SUTS-Jurisdictions ; https://tax.colorado.gov/local-government) Colorado also has a **Retail Delivery Fee** (flat per delivery, also in Minnesota) that engines must add. (https://docs.stripe.com/tax/custom)
- **Alabama**: many cities/counties are **self-administered** (or use private administrators such as RDS/Avenu) and have separate accounts; ADOR's **ONE SPOT** in My Alabama Taxes provides a single filing point for state-administered and non-state-administered local sales, use, rental and lodgings taxes. Remote sellers can instead join **SSUT (Simplified Sellers Use Tax)**: a flat **8%** on all Alabama sales regardless of locality, filed on one return; not available to sellers with physical presence. (https://www.revenue.alabama.gov/sales-use/one-spot/ ; https://www.trykintsugi.com/quick-reads/how-does-alabama-s-simplified-sellers-use-tax-program-simplify-sales-tax-compliance-for-businesses)
- **Louisiana**: local sales taxes are administered by parish-level collectors (about 54 separate local collection entities); a 2020 constitutional amendment to centralize failed 52-48 and 2026's HB 620 was deferred in committee (Mar 30, 2026). Remote sellers can file state and local tax through the **Louisiana Sales and Use Tax Commission for Remote Sellers** (single return, local rates by parish). (https://bizneworleans.com/louisiana-lawmakers-advance-sales-tax-collection-overhaul/ ; https://app.azure.legiplex.com/la/legislature/2026/2026-r/bills/hb620)
- **Arizona**: Transaction Privilege Tax (TPT) is legally a tax on the seller's privilege of doing business, organized by business classification codes (retail, restaurant, contracting, rentals...) and city/county codes; ADOR has administered and collected city TPT for all cities on one return since 2017. In-state sellers source to their business location; remote sellers to destination.
- **Alaska**: see section 1 (ARSSTC Uniform Code; non-member municipalities file directly).
- **Others with local quirks**: Illinois home-rule and non-home-rule municipal taxes, business-district taxes and (from 2026) local grocery taxes; Idaho and Montana resort-city taxes; Pennsylvania's only locals are Philadelphia (2%) and Allegheny County (1%); New Jersey Urban Enterprise Zones at half rate; Hawaii GET and New Mexico GRT are gross-receipts taxes on the seller that may be passed on.

### 3.3 Rate-change cadence and notice
- **SST states**: local rate changes take effect only on the **first day of a calendar quarter** after at least **60 days' notice** to sellers (120 days for catalog sellers); boundary changes follow the same rule. North Carolina, for example, posts boundary updates quarterly at least 30 days before effect and local rate changes with 60 days' notice before the quarter. (https://webserver.rilegislature.gov/Statutes/TITLE44/44-18.1/44-18.1-6.HTM ; NC DOR link above)
- **Non-SST examples**: Colorado state-administered local changes only Jan 1 or Jul 1; Illinois local changes are published in DOR bulletins and have recently landed on Jan 1 and Jul 1; California district taxes typically change at the start of a quarter; Texas local changes are quarterly. Expect changes **every quarter** somewhere.
- Engine implication: rates need `effective_from` / `effective_to` and must be selected by **transaction (or invoice/tax point) date**, so that credit memos and back-dated invoices use the historical rate.

### 3.4 Why 5-digit ZIP lookups are wrong
- USPS ZIP codes are delivery routes, not tax boundaries: a 5-digit ZIP often straddles city limits, counties and special districts. TaxJar's examples: Stillwell, OK, 9.75% inside city limits vs 6.25% outside in the same ZIP; Williston, VT, 7% by address or ZIP+4 vs 6% by ZIP5 because part of the ZIP is outside the city. (https://www.taxjar.com/blog/zip-codes-sales-tax)
- Precision ladder: **5-digit ZIP < ZIP+4 < address-range match < rooftop geocode (lat/long against jurisdiction polygons)**. SST boundary files return the most precise record available (address, then ZIP+4, then ZIP5). Under SST, where a seller cannot obtain the ZIP+4 after due diligence it may use the 5-digit rate; where a ZIP area has multiple rates the **lowest combined rate** applies (a 2024 SST amendment lets states choose highest, lowest or blended for 5-digit areas when sourcing digital goods without a street address), and states must hold sellers harmless for errors in state-provided databases. (https://streamlinedsalestax.org/docs/default-source/amendments/2024-amendments/sl23022a07---am24002a02-sourcing-without-complete-address-version-2---omaha-gb.pdf ; NC DOR page cites G.S. 105-164.42L relief)
- Non-SST states give no such safe harbor; Illinois now applies a 15% rate to destination sales with insufficient location data (see section 2.2). Engine implication: validate and standardize addresses (USPS/CASS or a geocoder) before tax lookup and store the matched jurisdiction codes on the invoice.

### 3.5 Free official data
- **SST rate and boundary files** (24 states: the 23 full members AR, GA, IN, IA, KS, KY, MI, MN, NE, NV, NJ, NC, ND, OH, OK, RI, SD, UT, VT, WA, WV, WI, WY plus associate member TN). (member list: https://www.streamlinedsalestax.org/Shared-Pages/State-Detail)
  - Download: https://streamlinedsalestax.org/ratesandboundry/Rates/ and https://streamlinedsalestax.org/ratesandboundry/Boundary/ ; index and update log: https://www.streamlinedsalestax.org/Shared-Pages/rate-and-boundary-files . File naming `[ST]B[YYYY]Q[n][MONDD].zip|csv` (e.g., `WAB2026Q4AUG27.zip`); as of early Oct 2026 most states had Q4-2026 files posted Aug-Sep 2026; single-rate states (IN, KY, MI, NJ, RI) carry old files because they have no local rates.
  - Cadence: **quarterly**, posted by the first day of the month before the quarter; new file only when something changed; corrections any time; email list for update notices (rate-boundaryupdates-subscribe@streamlinedsalestax.org).
  - Format: comma-delimited, fixed column order defined in the SST Technology Guide ch. 5. Boundary records carry a **record type** (`A` = address range with low/high house numbers and street name parts, `4` = ZIP+4 range, `Z` = 5-digit ZIP), begin/end effective dates (CCYYMMDD; open-ended rows use a far-future end date), and the resulting FIPS state, county, place and place-class codes plus special-district codes. Rate records list each jurisdiction's FIPS code, jurisdiction type and general and food/drug rates (intrastate/interstate) with effective dates. Lookups must filter by sale date and look up **each FIPS component** separately. (Ohio and Missouri instructions summarized at https://thefinder.tax.ohio.gov/StreamlineSalesTaxWeb/Download/SSTPRateTableInstructions.aspx ; NC DOR page above). Kansas also publishes an alternate boundary file for its food rate.
  - Coverage gap: these files cover only the 24 SST states; they do not cover CA, TX, NY, FL, IL, CO, AZ, LA, AL, PA, etc.
- **Washington DOR**: free address and lat/long lookup URL interfaces returning XML or text with the 4-digit WA **location code**, local rate and combined rate, plus result codes (0 = exact address match; others for ZIP+4/ZIP fallbacks), e.g. `https://webgis.dor.wa.gov/webapi/AddressRates.aspx?output=xml&addr=...&city=...&zip=...`; also downloadable quarterly address/jurisdiction files and a rate-lookup source-code library. No JSON. (https://dor.wa.gov/wa-sales-tax-rate-lookup-url-interface ; https://dor.wa.gov/taxes-rates/sales-use-tax-rates/washington-sales-tax-rate-library-source-code)
- **California CDTFA**: free Tax Rate API (`services.maps.cdtfa.ca.gov/api/taxrate/GetRateByAddress?address=&city=&zip=` and `GetRateByLngLat`) returning JSON `taxRateInfo` (can contain several candidate rates near boundaries) and `geocodeInfo`; no address validation; a SOAP version and an ArcGIS feature service also exist. (https://services.maps.cdtfa.ca.gov/ ; https://lab.data.ca.gov/dataset/california-sales-and-use-tax-rate-rest-api)
- **Texas Comptroller**: Sales Tax Rate Locator plus downloadable quarterly **address-level files** and a local jurisdiction rate file, formatted along SST guidelines (announced 2021). (https://comptroller.texas.gov/about/media-center/news/20210630-texas-comptrollers-office-releases-new-sales-tax-rate-resource-for-sellers-1626902560065)
- **Colorado**: SUTS jurisdiction lookup and DOR's GIS-based address lookup; publication DR 1002 lists state-collected rates. **New York**: online Jurisdiction/Rate Lookup by Address and Publication 718 (rate table by county/city with reporting codes). Most other states offer a web lookup but no bulk API; NC, OH, WI etc. publish SST files.
- **US Census Geocoder** (free, no key documented): `geocoder/geographies/onelineaddress|address|coordinates` returns state, county, county subdivision, incorporated place, tract and block codes (GEOIDs/FIPS); batch up to **10,000** addresses per CSV; benchmarks updated about twice a year. It does **not** know special tax districts, so it can map an address to state/county/city FIPS (useful for joining to SST rate files or state rate tables) but cannot produce a complete combined rate by itself. (https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html)

### 3.6 Commercial engines (deliverable (d))
SST Certified Service Providers (official list, Oct 2026): **Avalara, TaxCloud, Sovos, AccurateTax, Avior, Exactor (Intuit; certified but not offering the free CSP services)**. Vertex, Stripe/TaxJar, Anrok, Numeral, Kintsugi, Zamp and Commenda are not CSPs. A CSP's fees are paid by SST states for "CSP-compensated sellers" (sellers registered via SSTRS with no fixed place of business >30 days, <$50,000 property and <$50,000 payroll in that state, etc.), which makes filing in up to 24 states free for most remote sellers. (https://streamlinedsalestax.org/certified-service-providers/certified-service-providers-list ; https://www.streamlinedsalestax.org/certified-service-providers/freeservices/volunteer-definitions ; https://streamlinedsalestax.org/for-businesses/free-sales-tax-services)

| Provider | API style | Pricing model (2026) | Free tier / sandbox | Registers / files / remits | SST CSP | Coverage | Per-customer (BYO) credentials |
|---|---|---|---|---|---|---|---|
| **Avalara AvaTax** | REST v2 JSON (`/api/v2/transactions/create`), HTTP Basic with account ID + license key; tax codes, exemption cert mgmt (ECM) | Quote-based annual subscription by transaction band; Zamp reports a listed "Core Compliance" price of about $799 per state per year; median contracts reported $16-19k/yr (competitor sources) | Free developer sandbox account (`sandbox-rest.avatax.com`) | Yes (Avalara Returns / Managed Returns, registrations, ECM) | **Yes** | US + global (VAT, excise, Canada) | **Yes**: each company's account ID + license key; the standard model for QuickBooks/Xero/NetSuite-style connectors |
| **Stripe Tax** | REST form-encoded: `POST /v1/tax/calculations`, `POST /v1/tax/transactions/create_from_calculation`, reversals; per-line jurisdiction breakdown; usable with **non-Stripe payments** | Basic: 0.5% of volume (no-code) or **$0.50 per Transaction API call incl. 10 calculations, $0.05 per extra calculation; calculations-only $0.05/call**. Complete: **$90 / $430 / $1,000 / $1,500 per month** (200/1,000/2,500/5,000 tx; 2/4/6/10 registrations/yr; 4/12/20/32 filings/yr; extra US filing $55, extra US registration $150), 1-yr contract | Test-mode keys | Complete: yes. Filings via partners **TaxJar** and Taxually; US remote-seller registrations by Stripe | No | US + 100+ countries | **Yes**: customer's own Stripe account key (restricted key) or Connect "Tax for software platforms". Calculates only where a registration is configured in Stripe, otherwise returns zero |
| **TaxJar** (Stripe-owned) | REST JSON, token auth (`/v2/taxes`, `/v2/transactions/orders`) | Since Feb 2026: Starter $39-$319/mo by order volume; Professional $99-$1,599/mo (real-time API only on Professional); AutoFile about $50-55 per return; registration $299/state | 30-day trial; sandbox API on Professional | Yes (AutoFile in all states; registration service) | No | US-focused | **Yes**: per-customer API token |
| **Vertex O Series** | REST/SOAP, OAuth client credentials | Enterprise quote; Vendr data ~$40-100k/yr mid-market | Trial via sales | Express Returns, managed services | No | Global | Yes, per-tenant, usually via ERP connectors; heavy for SMB |
| **Sovos** | REST | Enterprise quote ($15k-$250k+/yr per aggregators) | Via sales | Yes | **Yes** | Global | Yes, per customer |
| **Anrok** | REST JSON, API key | About $100 per market per month for SaaS ($50 ecommerce) incl. registration and filing; custom tiers; possible GMV-based fees | Sandbox on request | Yes | No | US + VAT/GST (SaaS focus) | Yes, per-seller API key |
| **Numeral** | REST JSON (`POST /tax/calculations`, `/tax/transactions`), bearer `sk_test_`/`sk_prod_` keys | Free nexus monitoring; **$75 per return, $150 per registration**; API on custom plans | Test mode (returns rates everywhere) | Yes | No | US + some intl | Yes, per-customer key |
| **Kintsugi** | REST JSON (`POST /v1/tax/estimate`), headers `x-api-key` + `x-organization-id`; **partner-scoped keys** across client orgs | Free monitoring; Starter **$75 per filing or registration**; API on Premium (custom); claims no transaction fees | Free tier | Yes | No | US + intl | Yes; has an explicit partner (platform) key model |
| **Zamp** | REST JSON | Quote-based all-inclusive managed service (no per-filing or per-transaction fees claimed) | Free developer API trial | Yes (managed) | No | US (+70 countries claimed) | Yes, per-customer token |
| **TaxCloud** | REST, API login ID + key | Third-party figures: Starter about $19/mo, Premium about $79/mo (API on Premium); non-SST filings from about $39/return | 30-day trial | Yes; **free filing/registration in SST states** as CSP | **Yes** | US (+Canada) | Yes, per-customer keys |
| **Zip-Tax / Ziptax** | REST GET rate lookup by address, lat/long or ZIP (`v60` returns jurisdiction breakdown) | Starter free (100 calls/mo); Growth $29/mo; Pro $39/mo (product rules, nexus tracking, Canada); Enterprise custom | **Free 100 calls/month** | No filing (rate data only) | No | US (+Canada on Pro) | Yes, per-customer API key; good fit to feed a "manual" engine with rates |
| **Commenda** | REST, API token per organization; calc, transactions, nexus, registrations, filings endpoints | Third-party tracker: about $300/mo Basic, $1,000/mo Pro | Unclear | Yes (claims all 50 states) | No | US + global | Yes, per-org token |

Sources: Avalara: https://zamp.com/article/avalara-pricing , https://taxcloud.com/blog/avalara-pricing , https://developer.avalara.com/api-reference/avatax/rest/v2/ . Stripe: https://support.stripe.com/questions/understanding-stripe-tax-pricing , https://docs.stripe.com/tax/custom , https://docs.stripe.com/tax/connect . TaxJar: https://zamp.com/article/taxjar-pricing , https://support.taxjar.com/article/409-how-much-does-autofile-cost . Vertex/Sovos: https://www.vendr.com/buyer-guides/vertex , https://erpresearch.com/erp-add-ons/tax-compliance/sovos/pricing . Anrok: https://www.getsphere.com/blog/anrok-pricing . Numeral: https://docs.numeral.com/essentials/quickstart/quickstart , https://www.galvix.com/article/numeral-pricing/ . Kintsugi: https://docs.trykintsugi.com/docs/getting-started/authentication , https://trykintsugi.com/blog/best-sales-tax-software . Zamp: https://zamp.com/article/avalara-pricing (Zamp's own model description). TaxCloud: https://www.g2.com/products/taxcloud/pricing , https://taxcloud.com/lp/shopify-sales-tax-compliance/ . Ziptax: https://zip.tax/pricing . Commenda: https://pricingsaas.com/companies/commenda , https://api.docs.commenda.io/api-reference/sales-tax/introduction . Many price points come from competitor blogs or aggregators and should be confirmed with each vendor.

Integration takeaways for WeldBooks:
- All of these support a **bring-your-own-credentials** model (the WeldBooks workspace stores the customer's API key/license key, encrypted), so WeldBooks need not become a reseller. Kintsugi and Stripe additionally document platform/partner models.
- The cheapest credible "provider engine" defaults: **Stripe Tax calculations-only ($0.05/call)** for broad coverage, **Avalara** for mid-market customers who already have it, **TaxCloud/Avalara/Sovos** for customers who want free CSP filing in SST states, **Ziptax free tier** or **state files** for the manual engine's rate refresh.
- Provider responses differ in shape; normalize to WeldBooks' own per-line, per-jurisdiction tax detail (jurisdiction type, name, state-assigned code, rate, taxable amount, exempt amount, tax) so returns can be built from WeldBooks data regardless of engine.

---

## 4. Sourcing

### 4.1 Interstate vs intrastate
- **Interstate sales** (shipped from another state) are **destination-sourced in every state**: tax at the rate where the buyer receives the goods. Origin rules only govern **intrastate** sales by sellers located in the state.
- Over-the-counter sales are sourced to the store location everywhere.
- SST hierarchy (SSUTA Sec. 310): (1) where received at seller's location, (2) where received by purchaser (delivery address), (3) seller's records address of purchaser, (4) address obtained during sale (e.g., billing/payment address), (5) origin (address from which shipped / digital good first available). (summarized in https://www.numeral.com/blog/origin-based-vs-destination-based-sales-tax and SST docs)

### 4.2 Origin vs destination list (deliverable (b))
Destination is the default for the other 35 sales-tax states plus DC. Commonly cited origin states, verified for 2026:

| State | 2026 status | Nuances |
|---|---|---|
| Arizona | Origin (intrastate) | In-state retailers report TPT to the city of their business location; remote sellers are destination-based. |
| California | **Modified origin** | State, county and city (Bradley-Burns 1.25%) taxes are origin for in-state sellers; voter-approved **district taxes** are destination (if the seller is engaged in business in the district). Remote sellers: destination including districts. (https://www.californiacityfinance.com/SalesTaxSourcing180215.pdf) |
| Illinois | Origin for selling activity in Illinois | Retailers' Occupation Tax follows where the selling activity (order acceptance) occurs. Since **Jan 1, 2025** (P.A. 103-0983 / SB 3362) Illinois retailers shipping from out-of-state inventory, and all remote retailers, use destination sourcing incl. local taxes. (https://www.fonoa.com/resources/blog/illinois-extends-the-destination-based-sourcing-rules-to-all-retailers) |
| Mississippi | Origin | Very few local sales taxes; remote sellers collect the state rate at destination. |
| Missouri | Origin (intrastate) | Remote sellers: destination state + local use tax since Jan 1, 2023. |
| New Mexico | **No longer origin** | GRT switched to **destination sourcing on July 1, 2021**; exception: professional services requiring an advanced degree/license performed remotely are sourced to the seller's location. (https://weaver.com/resources/new-mexico-switches-destination-based-gross-receipts-and-compensating-tax/) |
| Ohio | Origin for vendors with an Ohio fixed place of business (goods) | Services sourced to destination; remote sellers destination. |
| Pennsylvania | **Now destination for local tax** | State 6% is uniform. **Act 21 of 2026 (SB 146)** moved the Philadelphia 2% and Allegheny County 1% local taxes to destination sourcing, retroactive to Jan 1, 2026, enforced from **Oct 1, 2026**; out-of-state sellers must now collect them on deliveries there. (https://www.avalara.com/blog/en/north-america/2026/08/pennsylvania-changes-local-sales-tax-sourcing-rules-october-2026.html) |
| Tennessee | Origin (intrastate) | DOR: sales within Tennessee are sourced to the seller's place of business; 2023 legislation (effective Jul 1, 2024) set destination rules for digital products/services and deliveries from out-of-state sellers. (https://tn.gov/revenue/news/2024/5/22/important-notice--tennessee-works-tax-act-updates-effective-july-1--2024.html) |
| Texas | Origin (intrastate) | Local tax sourced to the seller's place of business where the order is received; special rules when the order is received outside a place of business. Remote sellers: destination, or elect the **single local use tax rate (1.75%)** for an 8.0% total (Form 01-799; not available to Texas-based sellers or marketplace providers). (https://comptroller.texas.gov/taxes/sales/remote-sellers.php) |
| Utah | Origin (intrastate goods) | Services rules differ; remote sellers destination. |
| Virginia | Origin (intrastate) | Local 1% plus regional add-ons sourced to the seller's place of business; remote sellers destination. |

So for 2026 the practical origin list is **AZ, CA (modified), IL, MS, MO, OH, TN, TX, UT, VA**; **NM** and (for local tax) **PA** have moved to destination. Sources: https://www.numeral.com/blog/origin-based-vs-destination-based-sales-tax , https://www.taxjar.com/sales-tax/origin-based-and-destination-based-sales-tax , https://www.avalara.com/us/en/learn/whitepapers/origin-vs-destination-sales-tax.html.

### 4.3 Services, SaaS and digital goods sourcing
- Services are generally sourced to where the benefit is received / service is used (destination); some states source by where performed (e.g., NM licensed professional services performed remotely).
- **Digital products and SaaS**: sourced to the customer's location (billing address when no shipping address exists, per the SST hierarchy). For **business customers using SaaS in several states**, several states allow **multiple points of use (MPU)** apportionment: the buyer gives an MPU/exemption certificate and self-assesses apportioned use tax (e.g., Washington Digital Products and Remote Access Software Exemption Certificate apportioned by users; Massachusetts Form ST-12; Minnesota Stat. 297A.668 (option at time of purchase only); Ohio RC 5739.033; Texas multistate benefit certificate for data processing/SaaS with "any reasonable method of allocation"). (https://sovos.com/blog/sut/understanding-and-utilizing-the-multiple-points-of-use-exemption/ ; https://www.salestaxinstitute.com/resources/washington-clarifies-multiple-points-of-use-mpu-sales-tax-exemption-for-software-maintenance-agreements)
- Engine implication: each invoice line needs a **ship-from** address, a **ship-to/use** address (or billing address fallback), a `delivery_method` (shipped, picked up, electronically delivered, service performed), and an optional MPU allocation percentage per state from a certificate.

---

## 5. Taxability

### 5.1 Defaults
- **Tangible personal property is taxable by default**; exemptions are enumerated and vary: groceries (exempt in most states; reduced rates in e.g. Arkansas, Illinois localities, Tennessee, Utah, Virginia, Missouri; Illinois repealed its 1% state grocery tax from Jan 1, 2026 and localities may impose 1%), clothing (exempt or capped in e.g. MN, NJ, PA, VT, MA up to $175, NY up to $110 for state tax), prescription drugs (exempt almost everywhere). (Tax Foundation midyear 2026 page above)
- **Services are mostly exempt unless enumerated.** Broad-base exceptions: **Hawaii GET** and **New Mexico GRT** (gross-receipts taxes reaching most services), **South Dakota** and **West Virginia** (most services taxable unless exempted), plus Washington (expanded Oct 1, 2025) and Texas (enumerated but long list). Tax Foundation notes HI, NM and SD tax many B2B services.
- **Washington ESSB 5814**: from **Oct 1, 2025** retail sales tax applies to advertising services, IT support, custom software and customization of prewritten software, custom website development, live presentations, investigation/security, armored car and temporary staffing. In 2026 the legislature passed **ESSB 6346**, which **repeals most of that expansion from Jan 1, 2029** (advertising stays taxable) and adds earlier carve-outs from July 1, 2026; SB 6113 made technical fixes retroactive to Oct 1, 2025; penalty relief applies for Oct 2025 - Dec 2026 periods if requested by Sep 30, 2027; litigation under the Internet Tax Freedom Act is pending. (https://dor.wa.gov/taxes-rates/retail-sales-tax/services-newly-subject-retail-sales-tax ; https://www.ballardspahr.com/insights/alerts-and-articles/2026/04/washington-state-2026-session-legislature-repeals-and-rolls-back-certain-recently-enacted-taxes ; https://taxcloud.com/sales-tax-radar/washington-temporary-penalty-relief-program-essb-5814-by-sept-2027/)

### 5.2 SaaS and digital goods (deliverable (c))
Compiled from Numeral's state guide (published July 7, 2026, https://www.numeral.com/blog/sales-tax-on-saas) and TaxCloud's chart (updated Sep 24, 2026, https://taxcloud.com/blog/saas-sales-tax-by-state/), plus the specific sources cited. The 20 most populous sales-tax states are listed first, then other notable states. "Digital goods" = downloaded software/specified digital products.

| State | SaaS in 2026 | Downloaded software / digital goods | Notes and 2025-2027 changes |
|---|---|---|---|
| California | Not taxable | Electronically delivered software not taxable (only tangible media) | **SB 122 (signed Jun 29, 2026): SaaS and prewritten software in any form taxable from Jan 1, 2027**; custom software, digital audio/video/books/games excluded; sourced to billing address hierarchy. (https://ktslaw.com/blog/kilpatricks-state-and-local-tax-blog/2026/7/california-expands-sales-and-use-tax-to-saas-and-electronically-delivered-software ; https://www.anrok.com/resources/california-sb-122-heres-what-software-companies-need-to-know-before-the-deadline) |
| Texas | Taxable as data processing on **80%** of price (20% exempt, Tax Code 151.351) | Downloaded software taxable at 100% | 20% exemption lost if the service is also taxable under another category; MPU certificate allowed. (https://www.tx.cpa/news/latest-news/news/article/2026/02/06/data-processing-services-saas-and-software-licenses) |
| Florida | Not taxable | Generally not taxable | |
| New York | Taxable (prewritten software license) | Software taxable; most other digital goods not | |
| Pennsylvania | Taxable | Taxable | |
| Illinois | State: not taxable | State: generally not taxable | **Chicago Personal Property Lease Transaction Tax on SaaS ("nonpossessory computer leases") rose to 15% on Jan 1, 2026** (from 11% in 2025, 9% before), sourced to the user's access location, $100k economic nexus for remote providers. (https://www.salestaxinstitute.com/resources/chicago-personal-property-lease-transaction-tax-increase-2026) |
| Ohio | Taxable when bought for **business use** (automatic data processing / electronic information services); personal use exempt | Taxable | |
| Georgia | Not taxable | Not taxable | |
| North Carolina | Not taxable | Digital audio/video/books taxable | |
| Michigan | Not taxable | Downloaded software taxable | |
| New Jersey | Not taxable | Digital products taxable | |
| Virginia | Not taxable | Not taxable | |
| Washington | Taxable (remote access software is a digital product) | Taxable | ESSB 5814 services expansion (above); MPU certificate with user-based apportionment. |
| Arizona | Taxable (TPT, rental of TPP) | Taxable | City TPT may also apply. |
| Tennessee | Taxable (remotely accessed software) | Taxable | IaaS not taxable per Numeral; destination sourcing for digital products from Jul 1, 2024. |
| Massachusetts | Taxable | Taxable | MPU apportionment via Form ST-12. |
| Indiana | Not taxable | Downloaded software taxable | |
| Maryland | Taxable: **6%** consumer; **3%** for data/IT services and SaaS bought for enterprise use **from Jul 1, 2025** | Digital products 6% | Taxability follows the service, not the seller's NAICS; renewals after Jul 1, 2025 taxable; MPU allowed. (https://www.salestaxinstitute.com/resources/marylands-new-tech-tax-targets-digital-services ; https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/legal-publications/alerts/tax-alert-sales-and-use-tax-updates.pdf) |
| Missouri | Not taxable | Not taxable | |
| Wisconsin | Not taxable | Downloaded software and digital goods taxable | |
| Colorado | State: not taxable (some home-rule cities tax) | State: not taxable | **HB 26-1223 (enacted Jun 4, 2026): SaaS and downloaded software taxable from Jan 1, 2027** at 2.9% state + locals; custom and negotiated-license software excluded. (https://www.bpm.com/insights/colorado-expands-sales-and-use-tax/ ; https://www.claconnect.com/en/resources/articles/26/saas-sales-tax-california-colorado) |
| Minnesota | Not taxable | Digital products taxable | |
| South Carolina | Taxable | Taxable | |
| Louisiana | **Taxable since Jan 1, 2025** (digital products incl. SaaS, 2024 reform) | Taxable | Parish taxes may also apply. |
| Kentucky | Taxable (prewritten software access services) | Taxable | **Data brokering services taxable from Aug 1, 2026** (HB 757). |
| Utah | Taxable | Taxable | |
| Iowa | Taxable for consumers; exempt when sold to a commercial enterprise for business use | Same split | |
| Alabama | **Unclear**: vendor guides conflict | Software taxable | 2019 *Russell County* decision and Rule 810-6-1-.37 treat software as TPP; hosted SaaS treatment unresolved. (https://www.revenue.alabama.gov/ador-issues-guidance-on-taxability-of-computer-software/) |
| Also taxable (Numeral) | CT (1% computer and data processing rate, per CT law), DC, HI, NM, RI, SD, WV | | |

Engine implication: SaaS taxability differs by **buyer type (business vs consumer)** in OH, IA, MD and by **percentage of price** in TX; it is about to change in CA and CO on Jan 1, 2027. A product tax code plus a `customer_use` flag (business/personal) per line is needed.

### 5.3 Shipping and handling
- **Taxable even if separately stated** (examples): AR, CT, GA, IN, KY, LA, MN, NJ, NY, NC, OH, PA, TN, TX, WA, WI; generally follows the taxability of the goods (an exempt-only shipment carries exempt shipping in NY and others).
- **Exempt if separately stated** (often only if at actual cost / by common carrier): AZ, IA, MD, MO, NV, OK, UT, VA; Kansas from Jul 1, 2023; Michigan from Apr 26, 2023. California: exempt for common-carrier delivery separately stated, but **handling** and the excess over actual cost are taxable (Reg. 1628). Combining "shipping and handling" in one line often makes the whole charge taxable (CA, MD, ME, NV).
- Mixed shipments: allocate the delivery charge between taxable and exempt items by price or weight.
- (https://zamp.com/blog/shipping-taxability-by-state ; https://trykintsugi.com/blog/shipping-taxability-by-state ; https://stripe.com/resources/more/is-shipping-taxable)
- Colorado and Minnesota also charge a flat **retail delivery fee** per taxable delivery, independent of the shipping charge. (https://docs.stripe.com/tax/custom)

### 5.4 Product tax-code systems
- **SST Library of Definitions** (SSUTA Appendix C) defines uniform categories (food and food ingredients, candy, soft drinks, prepared food, clothing, prescription drugs, durable medical equipment, prewritten computer software, specified digital products, etc.); each SST member publishes a **Taxability Matrix** stating taxable/exempt per definition. These are the closest thing to an official code list.
- **Avalara tax codes** (e.g., `P0000000` general tangible personal property, freight codes in the `FR` family) and **Stripe tax codes** (`txcd_99999999` general tangible goods, `txcd_10103000` SaaS personal use, `txcd_10103001` SaaS business use, `txcd_30011000` clothing, `txcd_92010001` shipping, `txcd_92010004` handling) are proprietary. (https://docs.stripe.com/tax/custom ; https://docs.stripe.com/tax/tax-codes)
- Engine implication: WeldBooks should keep its **own product tax category** (aligned with SST definitions) and a mapping table to each provider's codes.

### 5.5 Bundling
A **bundled transaction** (distinct taxable and exempt items for one non-itemized price) is generally fully taxable unless the seller can identify the components from its books, or a de minimis/primary-purpose test applies (SST: taxable products 10% or less of the bundle price may be ignored; "true object" tests in non-SST states). Separately stating optional services (implementation, training, custom programming) keeps them out of tax in many states (e.g., Alabama and Chicago guidance above). Engine implication: price bundles at the component level on the invoice or let the user assign a bundle tax code.

### 5.6 Sales tax holidays
About 20-24 states held holidays in 2026 (mostly back-to-school: e.g., Texas, Ohio (back to a 3-day, narrow holiday after the 2024-25 expanded ones), Missouri, Virginia, South Carolina, Oklahoma Aug 7-9; Tennessee and New Mexico Jul 31-Aug 2; Maryland Aug 9-15; Connecticut Aug 16-22; Illinois Aug 7-16 at state rate only). **Florida made its back-to-school holiday permanent** (2026: Jul 20 - Aug 20, ~32 days) and replaced disaster-prep holidays with year-round exemptions from Aug 1, 2025. North Carolina, North Dakota and Pennsylvania had none. (https://www.avalara.com/blog/en/north-america/2026/01/sales-tax-holidays.html ; https://taxcloud.com/blog/sales-tax-holidays-2026/ ; https://www.taxjar.com/blog/2026-sales-tax-holidays)
Engine implication: holidays are date-bounded, item-category and price-per-item-capped exemptions; some apply only to state tax (localities opt in or out). Model them as dated taxability rules, not as rate changes.

---

## 6. Exemptions

- **Types**: resale (purchase for resale, the most common), exempt organizations (501(c)(3) charities, religious, schools: state-specific; not automatic), government (US federal government exempt; state/local governments exempt in many states, and federal credit cards are exempt when billed to the government), manufacturing (machinery and/or ingredients/components), agricultural, direct pay permits (buyer self-accrues), MPU/digital apportionment certificates, and entity-based exemptions (e.g., Native American tribes on reservations).
- **Forms**:
  - **SST Certificate of Exemption (Form F0003)**: one form for the 24 SST states (single purchase or blanket), with reason codes (A federal government ... G resale ... etc.) and state-specific ID requirements. (https://tax.nv.gov/wp-content/uploads/2024/03/SST-Certificate-Exemption-12-21-2021.pdf)
  - **MTC Uniform Sales & Use Tax Resale Certificate - Multijurisdiction**: resale only; accepted with conditions by about 36-38 states (CA, FL, HI, IL, MD, PA, WA reported as not accepting out-of-state resale IDs; DC, LA, MA, MS, NY, VA require their own forms); last revised Oct 14, 2022. (https://mtc.gov/resources/faq-uniform-sales-and-use-tax-certificate/ ; https://support.printful.com/hc/en-us/articles/41396659533457)
  - **State forms**, e.g., California CDTFA-230, Texas 01-339, New York ST-120 (resale)/ST-119.1 (exempt org), Illinois CRT-61, Florida DR-13 Annual Resale Certificate, Washington reseller permit.
- **Validity / renewal examples**: Florida's Annual Resale Certificate **expires every Dec 31** (sellers may rely on it past expiry for customers buying at least once every 12 months); Illinois blanket CRT-61 should be **updated at least every 3 years**, kept at least 3.5 years, and buyer registration verified online; Washington reseller permits are valid **48 months** (24 months for contractors and new or non-reporting businesses), renewable no earlier than 90 days before expiry; SST blanket certificates remain valid **while purchases are no more than 12 months apart**. Texas and California certificates have no fixed expiry but should be refreshed. (https://tax.illinois.gov/forms/sales/crt-61-instructions.html ; https://www.law.cornell.edu/regulations/washington/WAC-458-20-102 ; F0003 instructions above)
- **Good-faith acceptance**: under SST the seller is relieved of tax, interest and penalty if it obtains a **fully completed certificate at the time of sale or within 90 days after**, did not fraudulently fail to collect and did not solicit improper claims; the buyer bears eligibility risk. Georgia requires the seller to verify the purchaser's ID. Non-SST states have similar good-faith standards, often with an audit-time window to produce certificates.
- **Blanket vs single-purchase**: blanket covers future purchases of the same type from that seller; single-purchase is tied to one invoice/PO.
- **Retention**: keep certificates for the full statute of limitations of every period they support (typically 3-4 years after the return due date, longer if returns were not filed); Illinois sets 3.5 years minimum; Florida ties retention to the assessment period.
- **Exempt sales are still reported**: returns require **gross sales**, then deductions for exempt sales by reason (resale, exempt organizations, government, interstate, etc.), so the engine must store the exemption reason and certificate ID on each exempt line and keep exempt receipts in the nexus totals where the state counts gross sales.
- Engine implication: an exemption-certificate register per customer (type, states, reason code, ID number, issue/expiry date, blanket vs single, document file, verification status), with expiry alerts, and a rule that an exempt sale without a valid certificate is flagged (and treated as taxable on the worksheet if not cured within the state's window).

---

## 7. Calculation details

- **Rounding (SST rule, SSUTA Sec. 324)**: carry the computation to the **third decimal place** and round to a whole cent, **up when the third decimal is greater than four** (i.e., half-up at 0.005). Sellers may **elect item-level or invoice-level** computation, and rounding may be applied to the combined state + local tax. No member state may require a bracket system. (Rhode Island codification: https://webserver.rilegislature.gov/Statutes/TITLE44/44-18.1/44-18.1-25.htm ; NC G.S. 105-164.10 https://house.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_105/GS_105-164.10.html ; Utah R865-19S-117 https://www.law.cornell.edu/regulations/utah/Utah-Admin-Code-R865-19S-117)
  - Exceptions/notes: Florida replaced its bracket system with a rounding algorithm, applied per invoice or per item (https://www.floridarevenue.com/taxes/tips/Documents/TIP_21A01-02.pdf); Minnesota uses an equivalent half-cent rule (https://www.revenue.state.mn.us/revenue-notice/05-08-sales-and-use-tax-rounding-item-or-invoice); Texas rule 3.286 has historically been read as restricting rounding, with old rulings requiring rounding by rate group (verify); computing per jurisdiction vs on the combined rate can differ by a few cents per invoice (https://www.taxjar.com/blog/rounding-issues-sales-tax-returns).
  - The 2025-26 US penny phase-out produced **cash-total** nickel-rounding rules (e.g., Washington 2026 law, Michigan notice); these change the cash payable, not the tax computed. (https://www.michigan.gov/treasury/reference/taxpayer-notices/2025/12/08/sales-and-use-tax-notice-regarding-federal-phase-out-of-the-penny)
  - Engine implication: configurable per state: `line` vs `invoice` rounding, `per_jurisdiction` vs `combined`, half-up; store unrounded and rounded tax per jurisdiction so return totals reconcile.
- **Tax-inclusive pricing**: the norm is tax **separately stated** on the invoice. Several states allow tax-included prices if the invoice/receipt says "tax included" or separately shows the tax (e.g., Iowa, New York in advertising with "sales tax included", Colorado posted prices if the receipt itemizes). Texas (since Oct 1, 2019) and Pennsylvania (since Jul 1, 2019) let sellers advertise that they will absorb the tax only if the receipt separately states the tax; Texas may presume the whole invoice amount taxable without a separate statement. (https://www.law.cornell.edu/regulations/iowa/Iowa-Admin-Code-r-701-203-1 ; https://www.avalara.com/us/en/blog/2019/07/retailers-in-pennsylvania-and-texas-can-absorb-sales-tax.html ; https://ezel.ai/tax-rulings/tx/201711002l-invoice-tax-included-statement-burden-of-proof) Engine: support inclusive lines (back-calculate) but always print the tax amount.
- **Discounts and coupons**: a **seller's discount / store coupon** (seller not reimbursed) reduces the taxable price. A **manufacturer's coupon** or any discount reimbursed by a third party is generally **taxable** (tax on the pre-coupon price) in most states; a minority exclude it. Engine: distinguish `seller_discount` from `third_party_reimbursed_discount` on the line. (General rule; per-state list not verified, see section 12)
- **Returns / credit memos**: refunding the full price including tax lets the seller deduct the returned sale (or take a credit) on the return for the period of the refund; tax must be refunded to the customer before the seller can reclaim it. Credit memos must reuse the **original invoice's jurisdictions and rates**, not current ones.
- **Bad debts**: most states allow a deduction or credit for tax remitted on accounts later written off as uncollectible (SST: the federal income-tax bad-debt definition, claimed on the return for the period written off, with recoveries reported as taxable when collected). Engine: a write-off of an invoice that carried tax should generate a bad-debt deduction line per jurisdiction.
- **Deposits / prepayments**: generally tax is due when the sale occurs (title/possession passes or the invoice is issued, depending on the state and the reporting basis), not when a refundable deposit is taken; non-refundable deposits applied to a sale are part of the price. Engine: tax point = invoice date by default, configurable.
- **Cash vs accrual reporting**: most states require **accrual** (report in the period of the sale) — California and New York explicitly do; Washington allows cash only if the taxpayer uses cash for federal income tax; **Georgia** lets dealers with cash and credit sales choose; **New Mexico** GRT allows a cash-basis election (change by petition); **Hawaii** GET presumes cash basis; **Arizona** TPT allows a cash-receipts election (A.A.C. R15-5-2211); Texas rulings have allowed consistent cash reporting. (https://www.law.cornell.edu/regulations/new-mexico/N-M-Admin-Code-SS-3.2.2.14 ; https://law.justia.com/codes/georgia/title-48/chapter-8/article-1/part-2/section-48-8-45 ; https://efpradvisory.com/news/article-publication/business-services/new-york-sales-tax-must-be-remitted-on-accrual-method-of-accounting ; https://help.trykintsugi.com/en/articles/11369166-why-kintsugi-uses-the-accrual-accounting-method-for-sales-tax) Engine: per-registration `reporting_basis` (accrual default; cash only where allowed), with worksheets that can be built from invoices (accrual) or from payments allocated to taxable invoices (cash).
- **Freight**: see 5.3; delivery charges follow per-state rules and need their own tax code.

---

## 8. Collection and remittance

- **Accounting**: tax collected is a **liability per agency** (state DOR, and separately each self-administered locality, ARSSTC, Louisiana parish collector, Chicago, etc.), never revenue. Recommended ledger design: a `Sales tax payable` control account with sub-ledger detail by registration (agency) and jurisdiction, cleared by the remittance payment; vendor discounts kept as other income (or reduction of expense); differences between collected and due (over-collection must be remitted; under-collection is an expense) posted on filing.
- **Vendor discounts / timely-filing allowances**: roughly half the sales-tax states let the seller keep a small percentage of tax collected for timely filing and payment, usually capped (examples: Florida 2.5% of the first $1,200 of tax per return; Texas 0.5% for timely filing plus 1.25% for prepayment; New York 5% vendor collection credit capped per quarterly return; Pennsylvania 1% capped at $25 per monthly return; Georgia 3% on the first $3,000 plus 0.5% above; Illinois 1.75% with a monthly cap introduced in 2025). Many large states give none (e.g., CA, WA, NJ, NC, MA, CT, MN). **These figures could not be re-verified for 2026 in this session** (see section 12); the engine should hold vendor-discount rules as per-state data (rate, tiers, cap, timeliness/e-file conditions).
- **Filing frequencies** are assigned by the state at registration and reviewed periodically based on tax liability (typical bands: monthly for larger filers, quarterly for mid, annual for very small; e.g., Colorado lets DOR allow quarterly filing under $600/month tax from 2025). Some states also offer semi-annual or quarter-monthly/accelerated schedules. (https://www.salestaxinstitute.com/resources/colorado-changes-requirements-for-home-rule-jurisdictions-not-using-suts)
- **Due dates**: most commonly the **20th of the month after the period** (e.g., TX, FL, GA, IL, NY, NJ, PA, VA, NC, CO, AZ); others use the last day of the following month (e.g., California quarterly returns, ARSSTC monthly), the 23rd (Ohio), or the 25th (Washington). Weekend/holiday roll-forward rules differ. Engine: due-date rules per state and frequency as data.
- **Prepayment / accelerated payment states**: large filers in several states must make estimated or accelerated payments within the period (e.g., California quarterly prepayments, Illinois quarter-monthly payments, Missouri quarter-monthly, Michigan accelerated EFT, Arizona June estimated payment, Minnesota June accelerated payment, New York PrompTax); returns then credit the prepayments. (General knowledge; thresholds not re-verified for 2026)
- **Zero returns**: once registered, a return is due every period even with no sales; non-filing triggers penalties and estimated assessments.
- **Separate local returns**: Colorado home-rule cities not in SUTS (and SUTS itself as a separate filing channel), Alabama self-administered localities (or ONE SPOT), Louisiana parishes (or the Remote Sellers Commission for remote sellers), Alaska ARSSTC and non-member municipalities, Chicago lease tax and other city taxes, Arizona city TPT is on the state return.
- **SST Simplified Electronic Return (SER)**: a uniform electronic return (XML) used by SST states for sellers registered through SSTRS, reporting state totals plus jurisdiction-level detail; CSPs file on it. Detailed SER schema not re-verified here.
- **Per-jurisdiction return worksheet: data needed** (for each registration and period):
  1. Period, filing frequency, due date, reporting basis (accrual/cash), registration/account number.
  2. **Gross sales** delivered into the state (all channels), with **marketplace-facilitated sales** shown separately where the return asks.
  3. **Deductions by reason**: sales for resale, exempt organizations, government, interstate/out-of-state, exempt products (food, Rx, clothing...), non-taxable services, separately stated exempt freight, returns/allowances, bad debts, trade-ins, sales tax included in gross (if gross was tax-inclusive), MPU-exempt portions.
  4. **Taxable sales** = gross - deductions, split **by jurisdiction / location code** (WA 4-digit location codes, NY jurisdiction reporting codes (Pub 718), CA district/tax-area codes, TX local jurisdiction codes, CO jurisdiction codes, GA/NC/OH counties, PA Allegheny/Philadelphia, IL location codes) and by rate class (e.g., reduced food rate, single-article caps).
  5. **Tax due per jurisdiction** (rate x taxable) and **tax actually collected** (excess collected must be remitted).
  6. **Use tax due** on purchases (consumer use tax self-assessed), also by jurisdiction.
  7. Credits: **vendor discount**, **prepayments/estimated payments** already made, credits carried forward, tax paid to other states (for use tax).
  8. Penalty and interest (if late), and net payable.
  9. Drill-down: invoice and credit-memo list with line-level jurisdiction detail and certificate references, so an auditor can trace every number.

---

## 9. Use tax for buyers

- A business owes **consumer use tax** when it buys taxable goods or services for its own use and the vendor did not charge the destination state's tax (unregistered or remote vendor, or the vendor charged a lower rate: the difference is due), when it withdraws inventory bought for resale for own use, or when goods bought tax-free in one state are first used in another (credit for tax paid to another state is usually allowed).
- Self-assessment goes on the **sales and use tax return** if the business is registered as a seller, otherwise on a **consumer use tax return/account** (some states let individuals and small businesses report it on the income tax return). Chicago's lease tax and other city taxes have their own self-assessment duty when the vendor does not collect. (https://www.salestaxinstitute.com/resources/chicago-personal-property-lease-transaction-tax-increase-2026)
- **MPU / direct pay**: businesses that gave a vendor an MPU or direct-pay certificate must accrue the apportioned use tax themselves (Washington, Massachusetts, Minnesota, Ohio, Texas, Maryland). (https://sovos.com/blog/sut/understanding-and-utilizing-the-multiple-points-of-use-exemption/)
- **Typical accounting**: on the purchase bill, flag lines "use tax accrual" with the destination jurisdiction; post Dr the expense or asset account (use tax is part of cost, like sales tax paid) and Cr `Use tax payable` (per agency); the accrual flows into the return worksheet's use-tax line and is cleared on payment. No input credit exists, so there is no receivable side.

---

## 10. Penalties, audit risk and record retention

- **Liability for uncollected tax**: a seller that should have collected but did not owes the tax itself (it cannot usually recover it from customers later), plus interest and penalties. Collected-but-unremitted tax is a trust fund; **responsible officers can be personally liable** in most states.
- **Penalties**: late filing and late payment penalties are typically percentage-based and capped (commonly 5-10% per month up to about 25%), plus interest at statutory rates; fraud and failure-to-file penalties are higher; Illinois' 15% undetermined-location rate is an example of a rate-based penalty for poor location data. (State-specific figures not re-verified here)
- **Audit risk**: statute of limitations is usually **3-4 years** from the return due/filing date, but **unlimited if no return was filed** (the main exposure for unregistered remote sellers, hence VDAs). Common audit findings: missing or invalid exemption certificates, untaxed shipping, uncollected local/district taxes due to ZIP-level sourcing, consumer use tax on fixed-asset and software purchases, and marketplace-vs-direct sales double counting. MTC and state lookbacks: see 2.5.
- **Record retention**: keep transaction detail (invoices, credit memos, jurisdiction and rate applied, product tax code, customer address, exemption certificates, returns and workpapers, nexus analyses) for at least the statute of limitations of each period: typically **3-4 years**, longer in some states; Illinois sets 3.5 years minimum for resale certificates; Florida ties certificate retention to the assessment period. SST: the seller must maintain records of exempt transactions and provide them on request. (https://tax.illinois.gov/forms/sales/crt-61-instructions.html ; SST F0003 instructions above)
- Engine implication: never hard-delete posted tax detail; version rate tables; keep the engine response (provider transaction ID, jurisdiction breakdown) attached to each invoice.

---

## 11. What the accounting software must do (deliverable (e))

**Master data**
1. **Registrations** per workspace/entity: state (or agency: ARSSTC, LA Remote Sellers Commission, Colorado home-rule city, Alabama locality, Chicago), account number, start/end date, nexus reason (physical/economic/voluntary), filing frequency, reporting basis (accrual/cash), due-date rule, vendor-discount rule, SSTRS/CSP flag, prepayment obligations. Tax is only charged where an active registration exists (this is also how Stripe, Numeral and others behave).
2. **Jurisdiction and rate tables** with effective-dated rows, per component (state, county, city, district), each with a state-assigned reporting code; loaded from SST rate/boundary files, state files (WA, CA, TX) or a provider, or maintained by the user in the manual engine.
3. **Product tax categories** (SST-aligned) with per-state taxability rules (taxable/exempt/reduced rate/percentage-of-price, business-vs-consumer split, per-item caps, holiday windows) and a mapping to provider codes (Avalara, Stripe, TaxJar...).
4. **Customer tax profile**: exemption certificates (type, states, reason, ID, blanket/single, issue/expiry, file, verified), customer use (business/personal), MPU allocations.
5. **Addresses**: validated and standardized ship-from and ship-to/use addresses with ZIP+4 and, ideally, lat/long; store the resolved jurisdiction codes on the document.

**Calculation (both engines behind one interface)**
6. Determine sourcing per line: intrastate origin vs destination (state rule table, incl. CA's split for district taxes, PA's 2026 local change, IL's 2025 rule), interstate destination, pickup at seller location, electronically delivered goods (billing-address fallback hierarchy), services, MPU apportionment.
7. Apply taxability by product category, customer exemption, holiday, and per-state special cases (TX 80% SaaS base, MD 3%/6%, Chicago lease tax, retail delivery fees in CO/MN, TN single-article cap).
8. Compute tax **per jurisdiction**, apply configurable rounding (line vs invoice, per-jurisdiction vs combined, half-up), support tax-exclusive and tax-inclusive lines, distinguish seller discounts from third-party-reimbursed coupons, tax shipping/handling per state rule.
9. Persist the full breakdown on each invoice line (jurisdiction, code, rate, taxable, exempt amount and reason, tax, rule/version used, provider transaction ID); credit memos must reverse against the original breakdown and dates.
10. **Provider engine**: pluggable adapters (Stripe Tax calculations/transactions, Avalara AvaTax, TaxJar, others) using **customer-owned credentials** stored encrypted; commit/void transactions in the provider when invoices are posted/voided so provider-side filing (where used) stays in sync; graceful fallback and clear errors when the provider is unavailable (do not silently post zero tax).
11. **Manual engine**: user-maintained rates per jurisdiction for one or two states, optionally refreshed from free sources (SST files, WA/CA APIs, Ziptax free tier), with change reminders each quarter.

**Ledger**
12. Post collected tax to `Sales tax payable` with agency/jurisdiction dimensions; post consumer use tax accruals from purchase bills; post vendor discounts, prepayments, over/under-collection adjustments and penalties/interest on filing; treat tax paid on purchases as cost (no input tax recovery).
13. Marketplace-facilitated sales: record revenue without seller-collected tax; keep them visible for nexus and for returns that ask for them.

**Compliance outputs**
14. **Economic nexus monitor**: per-state thresholds with the correct base (gross/retail/taxable), window (prior CY, current CY, rolling 12 months, rolling 4 quarters, CT Oct-Sep), transaction-count test and AND/OR logic, marketplace inclusion; alerts at e.g. 80% and on crossing, with the collection start rule.
15. **Return worksheets** per registration and period (section 8 list): gross, deductions by reason, taxable by jurisdiction code, tax due vs collected, use tax, discounts, prepayments, net due, with drill-down to documents and export (CSV/PDF; SER-compatible data where feasible). Mark filed periods and lock them; later changes flow to amended-return worksheets.
16. **Filing calendar** with due dates, zero-return reminders and prepayment reminders; record payments against the liability.
17. **Exemption certificate management**: collection, expiry alerts, missing-certificate report (exempt sales without valid certificates), 90-day cure tracking.
18. **Consumer use tax report**: untaxed purchases by destination jurisdiction for review and accrual.
19. **Audit support and retention**: immutable history, rate-table versions, provider responses, certificates; retention at least the longest SOL (plan 4+ years, unlimited for unfiled periods).
20. **Change management**: rate-table refresh quarterly (SST/most states change on quarter starts; CO Jan/Jul), a rules registry for law changes with effective dates (e.g., CA and CO SaaS on 2027-01-01, WA 5814 rollback on 2029-01-01, NJ transaction-test repeal if enacted).

---

## 12. Uncertain or not verified for 2026 (deliverable (f))

Web searching hit the session limit before every item could be checked; the following should be confirmed before relying on them:

1. **Vendor discount percentages and caps** (section 8), including Illinois' 2025 monthly cap: from prior knowledge, not re-verified in 2026 sources.
2. **Due dates, filing-frequency thresholds and prepayment thresholds** per state (section 8): examples are from prior knowledge; need a per-state table from each DOR.
3. **Penalty rates and statute-of-limitations periods** per state (section 10): general ranges only.
4. **New Jersey S711** (200-transaction repeal): last reported action June 24, 2026; enactment status unknown.
5. **Marketplace-sales inclusion** column of the nexus table: trackers disagree for several states (e.g., WY, AZ, UT); verify per state.
6. **"Collection start" timing after crossing a threshold** (e.g., North Carolina's 60-day rule reported by Sales Tax Institute for July 2026): not verified at the DOR.
7. **Alabama SaaS taxability**: sources conflict; needs ADOR confirmation. Also whether specific Colorado home-rule cities (e.g., Denver) tax SaaS in 2026.
8. **California SB 122 details**: a reported $5 million aggregate threshold that shifts use-tax reporting to the purchaser (and a waiver form) is from a single law-firm summary; CDTFA regulations expected before Jan 2027.
9. **Colorado HB 26-1223**: whether it removed Colorado's MPU language (law firms disagree); home-rule alignment.
10. **Washington ESSB 6346**: reported as signed with a Jan 1, 2029 repeal of most ESSB 5814 services (advertising stays); confirm final signed text and the outcome of the ITFA litigation.
11. **Stripe Tax USD pricing** is from Stripe's support article (undated); the localized pricing page served EUR. **Avalara, Vertex, Sovos, TaxCloud, Anrok, Commenda** prices come from competitor blogs or aggregators; TaxJar's 2026 price increase is reported by competitors while its own support page still shows older AutoFile fees.
12. **Texas single local use tax rate for 2026** (1.75%): the Comptroller page says "current" without a year; confirm the 2026 Texas Register notice.
13. **Puerto Rico IVU 4% B2B rate** and any 2026 IVU reform: only vendor sources.
14. **SST Technology Guide field layouts** (exact column order of rate/boundary files): summarized from Ohio/Missouri/NC instructions because the SST PDF could not be parsed in this environment; read Chapter 5 of the Technology Guide before building the importer.
15. **SST Simplified Electronic Return (SER)** schema and which states require it for SSTRS registrants: not researched in detail.
16. **Discount vs manufacturer-coupon treatment and bad-debt rules by state**: general rules stated; no per-state table.
17. **Colorado SUTS participation count** for 2026 and whether all home-rule cities now use SUTS (HB 24-1041 fiscal note vs enacted text).
18. **ARSSTC membership count** (about 55 entries in the Q1-2026 update) and filing details: secondary sources; check arsstc.org.
19. **Prior-knowledge statements without a 2026 source in this report**: clothing/grocery exemption examples in 5.1 (e.g., MA $175, NY $110 thresholds), the Tennessee single-article cap (3.1, 11), Arizona's centralized city-TPT administration since 2017 (3.2), New Hampshire's Meals and Rooms tax (1), Connecticut's 1% rate on computer and data processing services (5.2), the New Jersey and North Carolina digital-goods rows (5.2), and the Avalara/TaxJar specific tax-code examples (5.4).
20. **Number of jurisdictions**: Vertex's 12,566 is described as "new and updated" jurisdictions; no official government census exists.

