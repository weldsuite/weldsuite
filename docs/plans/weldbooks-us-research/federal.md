# WeldBooks US support: federal accounting, tax and payments research

Research date: 2026-10-07. Scope: what a US small/mid-size business needs from its accounting software, excluding state sales and use tax, bank-feed aggregators and detailed payroll calculation. Every non-obvious fact has a source URL; "TY" = tax year.

## Key numbers at a glance

| Item | TY2025 | TY2026 | Source |
|---|---|---|---|
| §448(c) gross receipts test (cash method, §471(c), §263A, §163(j) exemptions) | $31,000,000 | $32,000,000 | Rev. Proc. 2024-40 §3.31; Rev. Proc. 2025-32 §4.30 |
| §179 expensing limit / phase-out start | $2,500,000 / $4,000,000 (OBBBA) | $2,560,000 / $4,090,000 | Rev. Proc. 2025-32 §3.02, §4.24 |
| §179 SUV cap | $31,300 (pre-OBBBA Rev. Proc.; see verify list) | $32,000 | Rev. Proc. 2024-40; 2025-32 |
| Bonus depreciation | 100% if acquired after Jan 19, 2025; 40% if acquired earlier | 100% (permanent); 20% for pre-Jan-20-2025 acquisitions | OBBBA §70301; Notice 2026-11 |
| 1099-NEC / most 1099-MISC boxes | $600 | $2,000 (indexed from 2027) | Rev. Proc. 2025-32 §2.15 |
| 1099-K (TPSO) | > $20,000 and > 200 transactions | same | IR-2025-107 |
| Backup withholding rate | 24% | 24% | Pub 1099 |
| Information-return penalty (per return, ≤30 days / by Aug 1 / later) | $60 / $130 / $340; intentional $680 | $60 / $130 / $340; intentional $690 | IRS penalties page; Rev. Proc. 2025-32 §4.57 |
| E-file threshold | 10 returns aggregated | same | T.D. 9972 |
| Social Security wage base | $176,100 | $184,500 | SSA via JofA |
| De minimis safe harbor | $2,500 (no AFS) / $5,000 (AFS) | same | Treas. Reg. §1.263(a)-1(f) |

URLs: https://www.irs.gov/pub/irs-drop/rp-24-40.pdf ; https://www.irs.gov/pub/irs-drop/rp-25-32.pdf ; https://www.irs.gov/pub/irs-drop/n-26-11.pdf ; https://www.irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000 ; https://www.irs.gov/payments/information-return-penalties ; https://www.journalofaccountancy.com/news/2025/oct/social-security-wage-base-and-cola-announced-for-2026/

---

## 1. Accounting standards and bases

- **US GAAP is the FASB Accounting Standards Codification (ASC).** It is mandatory only for SEC registrants. Private companies use it when a lender, investor, surety or regulator requires it. The US has no statutory chart of accounts, no prescribed ledger format and no public filing of private-company accounts. A survey of about 540 private-company CFOs found roughly 68% use GAAP (with or without exceptions), 22% tax or cash basis, and only 49% GAAP exclusively. https://tax.thomsonreuters.com/news/cfos-break-the-silence-first-broad-survey-in-decades-shows-how-private-firms-really-report/
- **Private Company Council (PCC) alternatives** inside GAAP include goodwill amortization, simplified hedging, the risk-free lease discount rate and ASU 2025-05 credit-loss relief. In 2026 the PCC is researching further lease simplification. https://dart.deloitte.com/USDART/home/news/all-news/2026/jun/fasb-pcc-meeting-highlights
- **Special purpose frameworks (AU-C 800)**: cash, modified cash, income-tax basis, regulatory and contractual bases. These are common for small businesses whose only users are the owner, the IRS and a local bank. No authoritative literature prescribes their presentation, and statement titles change (for example, "Statement of revenues and expenses, income tax basis"). https://www.aicpa-cima.com/resources/article/tax-and-cash-basis-financial-statements-appropriate-terminology-for-titles
- **AICPA FRF for SMEs** (2013) is non-authoritative, optional and has no size test. It is an accrual, historical-cost framework that sits between tax basis and GAAP (no CECL, no right-of-use leases). I found no 2024–2026 revision. Lender acceptance is the practical limit. https://onlinedigeditions.com/article/Accounting+%26+Assurance/4937690/842009/article.html
- **ASC 606 (revenue)**, effective for private companies from 2019–2020, implies contract and performance-obligation tracking, deferred revenue (contract liability), unbilled revenue (contract asset), ratable subscription schedules, milestone or percentage-of-completion recognition, standalone-selling-price allocation and refund liabilities.
- **ASC 842 (leases)**, effective for private companies in fiscal years beginning after Dec 15, 2021, puts operating and finance leases on the balance sheet. Private-company reliefs are the short-term (≤12 months) exemption by asset class and the risk-free-rate election by asset class (ASU 2021-09). The implicit rate must be used when it is readily determinable. https://dart.deloitte.com/USDART/home/publications/deloitte/heads-up/2021/fasb-asu-lessees
- **ASC 326 (CECL)** has applied to private companies since 2023, including trade receivables. **ASU 2025-05** (July 30, 2025; effective for annual periods beginning after Dec 15, 2025; prospective; early adoption allowed) lets all entities assume current conditions persist for current receivables and contract assets. Non-public entities may also consider cash collected after the balance-sheet date. https://dart.deloitte.com/USDART/home/news/all-news/2025/jul/fasb-amends-guidance-measurement-credit-losses-accounts-receivable-contract-assets
- **ASC 740 (income taxes)** matters mainly for C corporations, which record deferred tax on book/tax differences such as MACRS. Pass-throughs generally record no federal income tax.
- **Chart-of-accounts convention** (not statutory): 4- or 5-digit numbers by type. 1000s assets, 2000s liabilities, 3000s equity, 4000s revenue, 5000s cost of goods sold, 6000–7000s operating expenses, 8000–9000s other income/expense and taxes. Vendors ship industry templates (construction, nonprofit with net-asset classes, professional services) with optional account numbers.

**What the software must do**
- Produce accrual, cash and modified-cash statements from one ledger, labeled by basis.
- Provide deferred-revenue schedules, contract assets and liabilities, a lease module (ROU asset and liability, short-term exemption, discount rate per class), and a CECL allowance from AR aging with the ASU 2025-05 elections. C corps also need a deferred-tax worksheet.
- Ship US chart-of-accounts templates by entity type and industry, with equity matching the entity (§3) and a tax-line code per account.

## 2. IRS method of accounting and tax year

**Cash vs accrual (§448)**
- C corporations, partnerships with a C-corp partner, and all tax shelters must use accrual unless they pass the **§448(c) gross receipts test**: average annual gross receipts for the prior three tax years do not exceed **$31M for tax years beginning in 2025 and $32M for 2026**. https://www.irs.gov/pub/irs-drop/rp-24-40.pdf ; https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
- Gross receipts are net of returns and allowances. Short years are annualized. Receipts of commonly controlled entities are aggregated.
- Sole proprietors, S corporations and partnerships without C-corp partners are not limited by §448. Passing §448(c) also unlocks the §471(c) inventory simplification, the §263A UNICAP exemption, the §460 small-contract exemption and the §163(j) interest-limit exemption.

**Small-business inventory (§471(c))**
- A taxpayer that passes §448(c) may treat inventory as non-incidental materials and supplies. Alternatively, it may follow its applicable financial statement or, without one, its books and records. https://www.irs.gov/publications/p538
- COGS is reported on Form 1125-A or Schedule C Part III.

**Changing methods (Form 3115)**
- An overall method change (cash to accrual or back) or a change for a material item needs IRS consent on Form 3115.
- Automatic changes use designated change numbers. The current list is Rev. Proc. 2025-23, modified on Sept 4, 2026 by Rev. Proc. 2026-32 for R&E and residential construction. Non-automatic changes pay a user fee.
- A **§481(a) adjustment** catches up the difference. Positive adjustments are generally spread over four years; negative ones are taken in the year of change. https://kpmg.com/us/en/taxnewsflash/news/2025/06/tnf-rev-proc-2025-23-updated-annual-list-of-automatic-accounting-method-changes.html ; https://kpmg.com/us/en/taxnewsflash/news/2026/09/rev-proc-2026-32-accounting-method-changes-research-construction.html

**Tax year (§441, §444, §706, §1378)**
- Permitted years: calendar year, a fiscal year ending on the last day of any month, or a **52–53-week year**. A 52–53-week year always ends on the same weekday, either the last such weekday of a month or the one nearest month-end. https://www.irs.gov/publications/p538
- Required years:
  - Partnerships use the majority-interest partners' year, then the principal partners' year, then least aggregate deferral.
  - S corporations and personal service corporations use the calendar year.
  - Exceptions: an IRS-approved business purpose (Form 1128), a **§444 election (Form 8716**, deferral of 3 months or less, with §7519 required payments on Form 8752), or a 52–53-week year tied to an allowed year. https://www.irs.gov/instructions/i1120s
- Changing an existing year generally needs Form 1128. Automatic approval is available under Rev. Procs. 2006-45 and 2006-46 for many filers.

**Why both cash and accrual reports are needed.** The typical SMB keeps accrual books for management and lenders but files on the cash method (sole proprietors, S corps, partnerships and small C corps). Others keep cash books and convert to accrual for a bank. 1099 reporting is inherently cash-based. The software needs a basis toggle on the P&L and balance sheet. Cash basis excludes open AR/AP, and partial payments are prorated by line. A reconciliation should list the open AR, AP, accruals and prepaids that explain the difference; this report doubles as the §481(a) worksheet.

**What the software must do**
- Company settings: book basis, tax basis (cash, accrual or hybrid), tax-year definition (month-end, or a 52–53-week rule with weekday and "last vs nearest"), entity type, and the three-year gross-receipts history with an aggregation flag.
- Period calendars that support 52–53-week years and 4-4-5 periods.
- Cash and accrual versions of every financial report, plus the difference report.

## 3. Entity types, federal returns, book-to-tax and tax-line mapping

| Entity (tax classification) | Federal return | Due (calendar year) | Extension |
|---|---|---|---|
| Sole proprietor / single-member LLC (disregarded) | Schedule C (+ SE) on owner's Form 1040 | April 15 | Form 4868 → Oct 15 |
| Partnership / multi-member LLC | Form 1065 + K-1 per partner (K-2/K-3 if international items) | March 15 (15th day of 3rd month) | Form 7004 → Sept 15 |
| S corporation (Form 2553) | Form 1120-S + K-1 | March 15 (TY2025: March 16, 2026) | Form 7004 → Sept 15 |
| C corporation (21% flat rate) | Form 1120 | April 15 (15th day of 4th month; June-30 year-ends keep the 3rd month for years beginning before 2026) | Form 7004 → Oct 15 |
| Exempt organization | 990-N (gross receipts normally ≤ $50,000), 990-EZ (< $200,000 receipts and < $500,000 assets), 990, 990-PF, 990-T | May 15 (15th day of 5th month) | Form 8868 |

Sources: https://www.irs.gov/instructions/i1120s ; https://www.irs.gov/instructions/i1120 ; https://www.irs.gov/charities-non-profits/form-990-series-which-forms-do-exempt-organizations-file-filing-phase-in . An LLC defaults to disregarded entity or partnership status and may elect corporate status (Form 8832) and then S status (Form 2553).

**Book-to-tax schedules**
- **Schedule L**: balance sheet per books.
- **Schedule M-1**: reconciles book income to taxable income. Typical items are federal income tax per books, book vs tax depreciation, 50% meals, penalties and tax-exempt income.
- **Schedule M-2**:
  - Form 1120: retained-earnings roll-forward.
  - Form 1120-S: (a) Accumulated Adjustments Account, (b) shareholders' undistributed taxable income previously taxed, (c) accumulated E&P, (d) other adjustments account.
  - Form 1065: partners' capital.
- **Schedule M-3** replaces M-1 when **total assets are $10 million or more** at year end (1120, 1120-S, 1065). Partnerships also file it when adjusted total assets are ≥ $10M, total receipts are ≥ $35M, or a reportable entity partner owns ≥ 50%. https://www.irs.gov/instructions/i1120 ; https://www.irs.gov/node/40131
- **Small-entity exception**:
  - 1120 and 1120-S skip L, M-1 and M-2 when total receipts and total assets are both under $250,000.
  - 1065 skips them, plus K-1 item L, when receipts are under $250,000, assets under $1M, K-1s are furnished on time and no M-3 is required. https://www.irs.gov/instructions/i1065
- K-1 item L requires **tax-basis partner capital** (since TY2020), so tax-basis capital must be tracked per partner, separately from book capital.

**Tax-line mapping catalogs.** Each GL account carries a tax-line code per return type. The trial balance is summed by line and exported (Lacerte, UltraTax, CCH and Drake import trial balances by tax code). Catalogs must be versioned by tax year and include "non-deductible / M-1" codes.

- **Schedule C (2025)**
  - Part I: 1 gross receipts, 2 returns and allowances, 4 COGS, 6 other income.
  - **Part II expenses**: 8 Advertising; 9 Car and truck expenses; 10 Commissions and fees; 11 Contract labor; 12 Depletion; 13 Depreciation and section 179 expense; 14 Employee benefit programs; 15 Insurance (other than health); 16a Mortgage interest (paid to banks, etc.); 16b Other interest; 17 Legal and professional services; 18 Office expense; 19 Pension and profit-sharing plans; 20a Rent or lease of vehicles, machinery and equipment; 20b Rent or lease of other business property; 21 Repairs and maintenance; 22 Supplies; 23 Taxes and licenses; 24a Travel; 24b Deductible meals; 25 Utilities; 26 Wages (less employment credits); **27a Energy efficient commercial buildings deduction and 27b Other expenses (from line 48). These two lines swapped for 2025.** Line 30 is business use of home.
  - Part III COGS: 35 beginning inventory, 36 purchases, 37 labor, 38 materials and supplies, 39 other costs, 41 ending inventory, 42 COGS.
  - Part V, line 48: itemized other expenses. De minimis safe-harbor amounts are reported here.
  - Source: https://www.irs.gov/instructions/i1040sc
- **Form 1120-S, page 1 (2025)**
  - Income: 1a gross receipts, 1b returns, 2 COGS, 4 Form 4797 gain, 5 other income.
  - Deductions: 7 compensation of officers (Form 1125-E), 8 salaries and wages, 9 repairs and maintenance, 10 bad debts, 11 rents, 12 taxes and licenses, 13 interest, 14 depreciation, 15 depletion, 16 advertising, 17 pension and profit-sharing plans, 18 employee benefit programs, 19 energy efficient commercial buildings deduction, 20 other deductions, 21 total, 22 ordinary business income.
  - Separately stated items (charitable gifts, §179, portfolio income, §1231) go to Schedule K, not page 1.
  - Source: https://www.irs.gov/instructions/i1120s
- **Form 1065, page 1 (2025)**
  - Income: 1a–3 sales, returns, COGS and gross profit; 4 income from other partnerships; 5 farm profit; 6 Form 4797; 7 other income.
  - Deductions: 9 salaries and wages (non-partners), 10 guaranteed payments to partners, 11 repairs and maintenance, 12 bad debts, 13 rent, 14 taxes and licenses, 15 interest, 16a–c depreciation, 17 depletion, 18 retirement plans, 19 employee benefit programs, 20 energy efficient commercial buildings deduction, 21 other deductions, 22 total, 23 ordinary business income.
  - Source: https://www.irs.gov/instructions/i1065
- **Form 1120, page 1 (2025)**
  - Income: 1a–3 sales, returns, COGS and gross profit; 4 dividends and inclusions; 5 interest; 6 gross rents; 7 gross royalties; 8 capital gain; 9 Form 4797; 10 other income.
  - Deductions: 12 compensation of officers, 13 salaries and wages, 14 repairs and maintenance, 15 bad debts, 16 rents, 17 taxes and licenses, 18 interest, 19 charitable contributions, 20 depreciation, 21 depletion, 22 advertising, 23 pension and profit-sharing plans, 24 employee benefit programs, 25 energy efficient commercial buildings deduction, 26 other deductions, 27 total.
  - Below the deductions: 28 taxable income before NOL and special deductions, 29a NOL deduction, 29b special deductions, 30 taxable income.
  - Source: https://www.irs.gov/instructions/i1120

**Equity section per entity**
- **Sole proprietor**: owner's capital, contributions and draws. Draws close to capital at year end; there are no retained earnings.
- **Partnership/LLC**: capital per partner, covering contributions, income allocated by agreement ratios and distributions. Guaranteed payments are expenses, not draws. Track book and tax-basis capital.
- **S corporation**: common stock, APIC, retained earnings and distributions, plus AAA/OAA tracked for M-2. Officers must receive "reasonable compensation" as W-2 wages.
- **C corporation**: stock, APIC, retained earnings, treasury stock, dividends declared and AOCI.
- **Nonprofit (ASC 958)**: net assets with and without donor restrictions, and functional expense allocation (program, management and general, fundraising) for Form 990 Part IX.

**What the software must do**
- Entity type drives the equity template, the year-end close target and the tax-line catalog.
- Versioned mapping catalogs for Schedule C, 1065, 1120-S, 1120 and 990, plus Schedule K and M-1 tags.
- Reports: trial balance by tax line, Schedule L, M-1, M-2/AAA roll-forward, tax-basis partner capital, and a CSV export for tax software.
- A due-date calendar per entity type, with weekend and holiday roll-forward.

## 4. Depreciation and fixed assets

**MACRS** (Pub 946, https://www.irs.gov/publications/p946)
- **GDS classes and methods**: 3-, 5-, 7- and 10-year property use 200% declining balance; 15- and 20-year property use 150% declining balance. 27.5-year residential rental and 39-year nonresidential real property use straight line with the mid-month convention.
- **Common class assignments**: computers and vehicles are 5-year. Furniture and most equipment are 7-year. Qualified improvement property and land improvements are 15-year.
- **ADS**: straight line over longer lives (for example 40 years nonresidential, 30 years residential). Required for listed property used 50% or less for business and for some other cases.
- **Conventions**: half-year is the default. **Mid-quarter** applies if more than 40% of the year's personal-property basis is placed in service in the last quarter. Real property uses mid-month.
- Passenger autos are subject to the §280F caps, which are published annually.

**Section 179 (OBBBA §70306)**
- **2025: $2,500,000 limit**, reduced dollar for dollar above **$4,000,000** of §179 property placed in service. These amounts replaced the $1.25M / $3.13M figures from before OBBBA.
- **2026: $2,560,000 / $4,090,000**, with an SUV cap of $32,000.
- The deduction is also limited to business taxable income, with carryforward of the excess. It is elected per asset on Form 4562 and passes through on K-1s.
- Source: https://www.irs.gov/pub/irs-drop/rp-25-32.pdf

**Bonus depreciation (§168(k), OBBBA §70301)**
- **100% bonus is now permanent for property acquired after Jan 19, 2025.**
- Property acquired earlier keeps the TCJA phase-down: 40% if placed in service in 2025, 20% in 2026, 0% afterwards.
- For the first tax year ending after Jan 19, 2025, a taxpayer may elect 40% (60% for long-production property) instead of 100%. Electing out is done per class and is generally irrevocable.
- Interim guidance is **Notice 2026-11** (January 2026). https://www.irs.gov/pub/irs-drop/n-26-11.pdf ; https://taxnews.ey.com/news/2026-0250
- New **§168(n) qualified production property** allows 100% expensing for certain manufacturing buildings; its guidance is still pending. https://www.crowe.com/insights/tax-news-highlights/obbba-bonus-depreciation-notice-looks-to-tcja-regs
- Several states decouple from bonus depreciation (California does not conform), so a state tax book is needed. https://catalyst-cpa.com/irs-notice-2026-11-bonus-depreciation-election-guide/

**De minimis safe harbor (Treas. Reg. §1.263(a)-1(f))**
- **$2,500 per invoice or item** without an applicable financial statement (AFS); **$5,000** with one.
- It is an annual election made by a statement attached to a timely return, and it requires an accounting policy in place at the start of the year (in writing if the taxpayer has an AFS).
- Inventory and land are excluded. It is not a method change. No change was found for 2025 or 2026. https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations

**Book vs tax.** Book (GAAP) depreciation is straight-line over useful life with salvage value. Tax depreciation uses MACRS, §179 and bonus. The differences feed M-1/M-3 and, for C corps, ASC 740. Many SMBs use the tax book as the book book (income-tax-basis statements). Each asset therefore needs **multiple depreciation books** (book, federal, state, optional E&P), with disposal gain/loss per book and §1245/§1250 recapture for Form 4797.

**R&E (new §174A, OBBBA §70302)**
- For tax years beginning after Dec 31, 2024, **domestic R&E (including software development) is deductible currently**, or may be amortized over at least 60 months by election.
- **Foreign R&E is still amortized over 15 years.**
- Domestic R&E capitalized in 2022–2024 and not yet amortized can be deducted in 2025, or split across 2025 and 2026.
- Small businesses under the $31M test could make a retroactive election for 2022–2024. That election closed on July 6, 2026.
- Procedures are in Rev. Proc. 2025-28 and Rev. Proc. 2026-32.
- Sources: https://www.irs.gov/instructions/i1040sc ; https://www.grantthornton.com/insights/alerts/tax/2025/insights/full-expensing-of-domestic-research ; https://www.striketax.com/journal/after-the-july-6-section-174a-deadline-what-happens-next

**What the software must do**
- Asset register fields: **acquisition date** (to test the Jan 19, 2025 cutoff), placed-in-service date, basis, business-use %, MACRS class and ADS life, convention with an automatic mid-quarter test, §179 amount, bonus % or election-out by class, multiple books, disposals and recapture.
- Parameter tables keyed by tax year: §179 limits, bonus %, §280F caps.
- A de minimis policy setting that auto-expenses purchase lines under the limit.
- Per-book depreciation runs: the book book posts to the GL, and tax books feed reports and M-1 adjustments.
- A domestic/foreign R&E tag on accounts and projects.

## 5. Information reporting (1099, W-9, backup withholding, IRIS)

**Thresholds after OBBBA §70433**
- For **payments made after Dec 31, 2025**, the §6041(a) threshold is **$2,000**, up from $600. §6041A(a)(2) (1099-NEC) and §3406(b)(6) (backup withholding) cross-reference it. It is indexed from 2027; the 2027 amount is not yet published. https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
- **TY2025 forms (filed early 2026) still use $600. TY2026 forms use $2,000.**
- The instructions say "**$2,000 or more**", so exactly $2,000 is reportable. https://www.irs.gov/instructions/i1099mec
- Thresholds by form and box, TY2026 (same source):

| Form / box | TY2026 threshold |
|---|---|
| NEC 1a nonemployee compensation | $2,000 |
| NEC 1b cash tips, 1c Treasury tipped occupation code, 1d qualified overtime (new; subsets of 1a) | n/a |
| NEC 2 / MISC 7 direct sales of consumer products (checkbox) | $5,000 |
| NEC 4 / MISC 4 federal tax withheld | any amount |
| MISC 1 rents, 3 other income, 6 medical and health care, 9 crop insurance, 12/15 NQDC | $2,000 |
| MISC 2 royalties, 8 substitute payments | **$10** (unchanged) |
| MISC 10 attorney gross proceeds, 11 fish purchased for resale (cash) | **$600** (unchanged) |

**Exclusions**
- **Card and third-party-network payments** are reported on Form 1099-K by the payment settlement entity and "are not subject to reporting on Form 1099-MISC or Form 1099-NEC." https://www.irs.gov/instructions/i1099mec
- **Corporations** (including LLCs taxed as corporations) are exempt, except for legal services (NEC 1a or MISC 10), medical and health care (MISC 6) and certain federal-agency payments.
- Merchandise, freight, storage and similar payments are not reportable. Wages go on the W-2.

**1099-K (OBBBA §70432).** OBBBA retroactively restored the earlier threshold: a TPSO files only if payments **exceed $20,000 and number more than 200 transactions**. The IRS phase-down ($2,500 for 2025, $600 for 2026) is void. Payment-card acquirers have no de minimis. For WeldBooks users the 1099-K is incoming: the software should reconcile 1099-K gross (fees, refunds and tax included) to booked revenue. https://www.irs.gov/newsroom/irs-issues-faqs-on-form-1099-k-threshold-under-the-one-big-beautiful-bill-dollar-limit-reverts-to-20000

**Due dates** (next business day when a date falls on a weekend or holiday)
- **1099-NEC**: furnish to the recipient and file with the IRS by **January 31**. There is no automatic extension.
- **1099-MISC**: furnish by January 31 (February 15 for boxes 8 and 10). File by **February 28 on paper or March 31 electronically**.
- **Form 8809**: automatic 30-day filing extension, except for NEC and W-2. **Form 15397**: extension to furnish, requested by fax or online.
- **1042-S and 1042**: March 15. **Form 945**: January 31.
- Sources: https://www.irs.gov/publications/p1099 ; https://www.irs.gov/instructions/i1099mec

**E-file mandate.** Anyone filing **10 or more information returns in aggregate** across all types (1099, W-2, 1042-S, etc.) must e-file, for returns due on or after Jan 1, 2024. The waiver is Form 8508, filed at least 45 days before the due date. https://www.irs.gov/publications/p1099

**FIRE retirement and IRIS (status as of 2026-10-07)**
- IR-2026-99 (Aug 24, 2026) sets the FIRE shutdown dates:
  - Nov 1, 2026: last FIRE test file.
  - Nov 9, 2026: last change to FIRE TCC applications.
  - **Nov 19, 2026, 3 p.m. ET: FIRE closes.**
  - TY2026 returns (2027 season) must go through IRIS, which will carry every form FIRE supported.
  - New FIRE TCC applications closed in July 2026.
  - https://www.irs.gov/newsroom/irs-reminder-information-return-e-file-system-transitioning-to-a-new-platform ; https://www.criadv.com/insight/irs-fire-to-iris-transition-2027/
- **IRIS Taxpayer Portal**: free and web-based, with manual entry or **CSV upload of up to 100 records per file** (header excluded).
  - One form type per CSV; unlimited number of files.
  - Templates are downloaded from the IRIS dashboard after login, column headers are validated, and the files are sensitive to stray spaces, commas and blank rows.
  - Some vendors cite 250 records per CSV; IRS publications say 100.
  - https://www.irs.gov/pub/irs-pdf/p5719.pdf ; https://www.irs.gov/pub/irs-efile/iris-working-group-meeting-02112026.pdf
- **IRIS A2A**:
  - XML schemas, distributed to TCC holders through the Secure Object Repository.
  - Requires a separate **IRIS TCC** (FIRE TCCs don't carry over) and an **API Client ID** (Pub 5718).
  - Roles: Issuer, Transmitter, Software Developer. Software developers must pass **IRIS ATS** testing (open year-round, no live data) and get a new Software ID each tax year for each form.
  - Each transmission needs a Unique Transmission Identifier (UTID). An "Accepted with Errors" status requires corrections. CSV is not accepted.
  - Forms (TY2025): 1042-S, 1097-BTC, the 1098 family, 1099-A/B/C/CAP/DA/DIV/G/INT/K/LS/LTC/MISC/NEC/OID/PATR/Q/QA/R/S/SA/SB, 3921, 3922, the 5498 family and W-2G.
  - W-2s are not filed through IRIS; they go to SSA Business Services Online.
  - https://www.irs.gov/pub/irs-pdf/p5719.pdf
- **Implication**: start with IRIS-Portal CSV export (≤100 rows, one form per file) and PDF recipient copies. Then either become an IRIS A2A software developer/transmitter or partner with a commercial transmitter. Do not build a FIRE (Pub 1220) exporter.

**Combined Federal/State Filing (CF/SF).** The IRS forwards 1099 data to participating states. Pub 1220 (Rev. 5-2026) lists two-digit codes: AL 01, AZ 04, AR 05, CA 06, CO 07, CT 08, DE 10, DC 11, GA 13, HI 15, ID 16, IN 18, KS 20, LA 22, ME 23, MD 24, MA 25, MI 26, MN 27, MS 28, MT 30, NE 31, NJ 34, NM 35, NC 37, ND 38, OH 39, OK 40, PA 42, RI 44, SC 45, WI 55. Missouri was removed. IRIS supports the same forwarding. https://www.irs.gov/pub/irs-pdf/p1220.pdf

Many states still require direct filing, especially when state tax was withheld, and the list is unreliable per form. Maintain a per-state table. https://trolley.com/blog/how-does-the-combined-federal-state-filing-cf-sf-program-work/

**W-9, TIN Matching, backup withholding**
- Collect a **W-9** (name, business name, tax classification, exemption codes, TIN, certification) before the first payment. The tax classification drives the corporate exemption.
- **Backup withholding at 24%** applies when:
  - the payee gives no TIN;
  - the IRS sends an incorrect-TIN notice (CP2100/972CG). Send a "B" notice and withhold on payments made more than 30 business days after receiving it. A second notice within 3 years requires SSA/IRS validation.
  - the payee fails to certify;
  - the IRS orders it for underreporting.
- Report backup withholding in box 4 and on **Form 945**. https://www.irs.gov/publications/p1099 ; https://www.irs.gov/pub/irs-pdf/p1281.pdf
- **IRS TIN Matching** is free through e-Services. Interactive checks take up to 25 name/TIN pairs and answer immediately. Bulk files take up to 100,000 pairs and return results within 24 hours. It is available only to payers who filed 1099s in the last two years, each user needs Secure Access registration, and there is no public API. https://www.irs.gov/tax-professionals/taxpayer-identification-number-tin-matching

**Electronic furnishing.**
- Requires **affirmative electronic consent** given in a way that shows the recipient can access the statement.
- Required disclosures before consent: paper fallback, scope and duration, how to get paper copies, how to withdraw (in writing), termination, how to update information, and hardware/software requirements.
- The statement must be posted by the due date and kept available **through October 15**, with a notice sent by email or mail.
- New consent is needed after hardware or software changes.
- Source: https://www.irs.gov/publications/p1099

**Foreign payees**
- Collect **W-8BEN** (individuals) or **W-8BEN-E** (entities). A form is generally valid through the end of the third calendar year after signing. https://www.irs.gov/instructions/iw8ben
- US-source FDAP income is subject to 30% withholding unless a treaty reduces it, and is reported on **Form 1042-S** (due March 15, filed via IRIS for 2026) and Form 1042.
- Services performed entirely abroad are foreign-source income: no 1099, and generally no 1042-S. https://www.irs.gov/publications/p515 ; https://www.irs.gov/individuals/international-taxpayers/source-of-income-personal-service-income

**Penalties (§6721/§6722)**
- Returns due in **2026**: $60 / $130 / $340, intentional disregard $680. https://www.irs.gov/payments/information-return-penalties
- Returns due in **2027**: $60 / $130 / $340, intentional disregard the greater of $690 or 10%.
- Annual caps for filers with ≤ $5M gross receipts: $244,500 / $698,500 / $1,397,000. Others: $698,500 / $2,095,500 / $4,191,500. https://www.irs.gov/pub/irs-drop/rp-25-32.pdf

**What the software must do**
- Vendor master: legal name, DBA, TIN type and TIN (encrypted), W-9 classification, exempt-payee code, W-9/W-8 document and date, TIN-match status, backup-withholding flag, 1099 flag, default form and box, foreign flag.
- Map accounts or bill lines to form and box, with overrides.
- Aggregate **payments by payment date** per payee per calendar year. Exclude card and TPSO payments, apply per-box per-year threshold tables, and skip corporations except legal and medical.
- Post 24% backup withholding to a liability account and feed Form 945.
- Recipient PDFs with truncated TINs, an e-consent workflow, IRIS CSV export, corrections, and a year-end 1099 review report.

## 6. Record keeping

**Retention** (IRS: https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records)

| Situation | Keep records |
|---|---|
| General | 3 years |
| Refund claims | 3 years, or 2 years after payment if later |
| More than 25% of income omitted | 6 years |
| Bad-debt or worthless-securities claims | 7 years |
| No return filed, or fraudulent return | Indefinitely |
| Employment tax records | At least 4 years after the tax is due or paid |
| Property records | Until the limitations period expires for the year of disposal |

Practical default: never purge ledger data and source documents for at least 7 years, and keep asset history for the asset's life plus 7 years.

**Electronic records**
- **Rev. Proc. 98-25** (https://www.irs.gov/pub/irs-drop/rp-98-25.pdf) applies to taxpayers with ≥ $10M in assets. It also applies to smaller ones whose records exist only electronically, which is the normal case for cloud accounting. Its requirements:
  - Retain machine-sensible records at least until the assessment period, including extensions, expires.
  - Records must "reconcile with the taxpayer's books and the taxpayer's return" through an **audit trail**: account totals in the records tie to the books and to the return.
  - Records must hold "sufficient transaction-level detail" to identify source documents.
  - Records must be provided "capable of being processed."
  - Keep documentation of the business processes, "the internal controls used to prevent the unauthorized addition, alteration, or deletion of retained records," and "the charts of accounts and detailed account descriptions."
- **Rev. Proc. 97-22** (imaging and electronic storage) requires integrity and reliability controls, controls to prevent and detect unauthorized changes, an inspection and quality-assurance program, an **indexing and retrieval system**, and legible reproduction. A compliant system allows paper originals to be destroyed. https://www.irs.gov/node/4437

**Audit trail and locking (practice, not statute).** Private companies have no statutory immutable-journal rule (no FEC or GoBD equivalent), and SOX applies only to SEC registrants. Auditors and lenders still expect:
- no physical deletion of posted entries; corrections by reversal or void;
- user and time stamps on every entry;
- change history on master data (vendor bank details and TINs are a fraud vector);
- role-based segregation of duties;
- closed periods with a logged override, like QuickBooks' "closing date."

**What the software must do**
- Immutable posting with reversals, field-level change logs, and a period lock with a "changes after close" report. Also a separate lock for periods already covered by a filed return.
- Indexed attachments (receipts, W-9s) with retention holds.
- Full GL, sub-ledger and master-data export with account descriptions.
- A trial-balance-to-return mapping report, which closes the 98-25 audit trail.

## 7. Other business taxes that hit the ledger

**State income, franchise and pass-through taxes**
- Most states tax corporate income, generally with single-sales-factor apportionment. Many add net-worth franchise taxes or minimums (for example, Delaware's franchise tax and California's $800 minimum).
- **Pass-through entity taxes (PTET)** are available in 36 states plus NYC. OBBBA kept them while raising the individual SALT cap to $40,000 for 2025, rising 1% a year through 2029 and phased down above $500,000 MAGI. https://www.cooley.com/news/insight/2025/2025-07-15-federal-tax-legislation-extends-and-increases-salt-cap-preserves-ptet-workarounds
- PTET is an entity-level state tax expense. Taxes paid on an owner's behalf are distributions.

**Gross receipts taxes** are taxes on revenue, accrued as an operating expense.
- **Washington B&O**: rates vary by activity.
  - From Oct 1, 2025, the services rate is tiered: 1.5% under $1M, 1.75% for $1–5M, 2.1% above $5M of affiliated-group gross income.
  - Retailing is 0.471%, rising to 0.5% in 2027.
  - A 0.5% surcharge applies above $250M of taxable income from 2026.
  - 2026 law SB 6346 adds future relief and a higher filing threshold.
  - https://taxnews.ey.com/news/2025-1125 ; https://taxnews.ey.com/news/2026-0853
- **Ohio CAT**: 0.26% above a **$6M exclusion** (from 2025). The minimum tax was eliminated from 2024. https://hbkcpa.com/insights/ohio-cat-exclusion-increases-january-1-2025/
- **Oregon CAT**: $250 plus 0.57% of commercial activity above $1M, after a 35% subtraction. Registration is required at $750,000. https://www.oregon.gov/dor/programs/businesses/Pages/Corporate-Activity-Tax.aspx
- **Texas franchise (margin) tax**: 0.75%, or 0.375% for retail and wholesale; EZ computation 0.331% for revenue up to $20M. The no-tax-due threshold is **$2.47M for 2024–25 reports and $2.65M for 2026–27**, and an information report is still required below it. https://comptroller.texas.gov/taxes/franchise/
- **Nevada Commerce Tax**: applies above $4M of Nevada gross revenue (July–June year), at 0.051%–0.331% by NAICS category. A return is required even below the threshold. https://TAX.NV.GOV/uploadedFiles/taxnvgov/Content/Home/Features/2015_Legislative_Summary.pdf
- **Delaware gross receipts tax**: about 0.0945%–1.9914% by category, with monthly or quarterly exclusions. https://revenuefiles.delaware.gov/TaxTips/tt-contractor2018.pdf
- **Tennessee business tax**: state plus city tax by classification (Classes 1–5), with a $22 minimum per location. TN franchise and excise tax is separate. https://www.tn.gov/content/dam/tn/revenue/documents/tax_manuals/june-2025/Business-Tax-Manual.pdf
- Local gross receipts taxes also exist, for example Philadelphia BIRT, San Francisco's gross receipts tax and Virginia BPOL.

**Estimated taxes**
- C corporations pay four installments: Apr 15, Jun 15, Sep 15 and Dec 15 (calendar year), through EFTPS. Penalties are computed on Form 2220.
- Owners of pass-throughs pay personally on Form 1040-ES: Apr 15, Jun 15, Sep 15 and Jan 15.
- https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes

**Other taxes and obligations**
- Business personal-property tax returns, which list fixed assets by location.
- Federal excise tax (Form 720).
- **Unclaimed property (escheat)**: uncashed vendor checks and customer credits after state dormancy periods.

**What the software must do**
- Liability accounts and a due-date calendar per jurisdiction and tax.
- Gross-receipts base reports by state, location and activity.
- Treat owner-level payments as draws or distributions.
- Aging of uncashed checks and credits by owner state for escheat.

## 8. Payroll implications (summary)

**Forms and rates**
- **Form 941**: quarterly, due Apr 30, Jul 31, Oct 31 and Jan 31. Deposits are monthly or semiweekly under the lookback rule. Very small employers file Form 944.
- **Form 940**: FUTA, due Jan 31. The rate is 6.0% on the first $7,000 per employee, usually 0.6% net of the state credit.
- **W-2/W-3**: go to SSA, not IRIS. TY2026 forms are due Feb 1, 2027.
- The TY2026 W-2 adds box 12 codes **TP** (qualified tips), **TT** (qualified overtime) and **TA** (Trump account), and box 14b for the tipped occupation code. https://www.natptax.com/news-insights/blog/draft-2026-form-w-2-adds-codes-for-tips-overtime-and-occupation-data/ ; https://www.irs.gov/publications/p15
- Social Security wage base: $184,500 for 2026. Medicare is 1.45% each side, plus 0.9% on employee wages above $200,000.
- State obligations: income tax withholding, SUI, disability and paid-leave programs, and new-hire reporting.

**Journal entries per pay run**
1. **Record payroll**: debit gross wages by department, employer taxes (FICA match, FUTA, SUI) and employer benefits. Credit the liabilities: FIT withheld, FICA, FUTA, SUI, state and local withholding, benefit/401(k)/garnishment payables, and net pay clearing.
2. **Net pay**: clear net pay against cash.
3. **Tax impounds**: clear the tax liabilities against cash (providers pull taxes early, so use an impound clearing account).

For S corps, officer wages map to 1120-S line 7 and other wages to line 8. Health insurance for 2% shareholders is added to W-2 box 1.

**Integration patterns.** SMB ledgers import one summarized journal entry per pay run, using category-to-GL mapping by earning type, tax, benefit and department.
- **Gusto**: native QuickBooks Online and Xero sync with default and detailed mapping; it cannot post to AR or AP. For embedded partners, Gusto offers a **General Ledger API**: you POST a report request, then GET a balanced journal by UUID, grouped by job or department. There are no webhooks, so polling is required. https://support.gusto.com/article/102998113100000/Account-mapping-types-for-accounting-integrations ; https://docs.gusto.com/embedded-payroll/changelog/general-ledger-api-now-available
- **Rippling**: native connectors to QuickBooks Online, Xero, Sage Intacct and NetSuite, with report export for other ledgers. https://rippling.com/blog/announcing-5-new-time-saving-tools-for-accountants
- **ADP and Paychex**: GL CSV exports and marketplace connectors.

**What the software must do**
- Payroll clearing and impound accounts, plus liability accounts per jurisdiction.
- A payroll JE import (CSV first, Gusto API later) with category mapping, dimensions and idempotent pay-run IDs.
- Keep contractor payments made through payroll providers out of WeldBooks' own 1099 totals.
- 941/940/W-2 reconciliation reports.

## 9. US payments that accounting software supports

**Check printing**
- The **MICR E-13B** line is printed in MICR toner and reads, from left to right:
  - auxiliary on-us field (the check serial on business checks);
  - transit field (the 9-digit routing number between ⑆ symbols);
  - on-us field (the account number);
  - amount field, encoded later by the bank.
- Placement follows ANSI X9.100-160, paper X9.100-10, and security features X9.100-170 / TR 8. Banks supply MICR specifications, and alignment should be verified with a MICR gauge. https://en.wikipedia.org/wiki/Magnetic_ink_character_recognition ; https://webstore.ansi.org/standards/ascx9/ansix91001602021
- Stock: **voucher checks on US Letter** (check on top, middle or bottom, with two stubs) and 3-per-page checks, either pre-printed or blank. Blank stock means the software prints the MICR line and bank details.
- Checks print the amount in words ("...and 56/100 dollars"), with dual signatures above a threshold.
- **Positive Pay**: a per-bank issued-check file (check number, account, amount, date, payee for payee-match, void flag). There is no common standard. https://www.alerus.com/wp-content/uploads/2025/11/Positive-Pay-Issued-check-file-guide_2025-11-20.pdf

**ACH (Nacha file)**
- **Format**: **94-character records** with a **blocking factor of 10**; the file is padded with all-9 records. https://achdevguide.nacha.org/ach-file-details
- **Record types**:
  - **1 File Header**: immediate destination and origin, YYMMDD date, file ID modifier, "094", "10", format code "1".
  - **5 Batch Header**: service class 200 (mixed), 220 (credits) or 225 (debits); company name and 10-character company ID; SEC code; 10-character entry description; effective entry date; ODFI.
  - **6 Entry**: transaction code (22/27 checking credit/debit, 32/37 savings, 23/28/33/38 prenotes); 8-digit RDFI plus check digit; account (17); amount in cents (10); ID (15); name (22); trace number (15).
  - **7 Addenda**: type 05 with 80 characters. CCD/PPD allow one addenda record. **CTX allows up to 9,999**, carrying an X12 820.
  - **8 Batch Control** and **9 File Control**: counts, entry hash (sum of RDFI IDs, rightmost 10 digits) and totals.
- **SEC codes**: PPD (consumer, payroll), CCD/CCD+ (B2B with one remittance addenda), CTX (B2B with full EDI remittance), WEB and TEL (consumer debits).
- **Balanced vs unbalanced**: a balanced file includes the offsetting entry to the originator's account; an unbalanced file leaves the offset to the ODFI. Make this a per-bank setting.
- **Same Day ACH**: three windows (ODFI deadlines about 10:30, 2:45 and 4:45 ET). The **$1M per-payment limit** rises to **$10M on Sept 17, 2027**, and splitting payments to stay under it is prohibited. https://www.nacha.org/million ; https://www.nacha.org/news/same-day-ach-payment-limit-increase-10-million
- **2026 Nacha rules (in force)**:
  - **Fraud monitoring**: originators, ODFIs and third parties must run risk-based monitoring for fraudulent and "false pretenses" entries (BEC, vendor impersonation). **Phase 1 began Mar 20, 2026** for parties with ≥ 6M originations in 2023 (RDFIs ≥ 10M). **Phase 2 began June 19, 2026** (effectively June 22) for everyone else. Procedures must be reviewed annually.
  - **Entry descriptions**: **"PAYROLL"** (PPD wage credits) and **"PURCHASE"** (consumer WEB debits for online goods) became mandatory on Mar 20, 2026.
  - https://www.nacha.org/rules/risk-management-topics-fraud-monitoring-phase-1 ; https://www.nacha.org/rules/risk-management-topics-fraud-monitoring-phase-2 ; https://www.nacha.org/rules/risk-management-topics-company-entry-descriptions
  - Positive Pay alone does not satisfy the monitoring rule. https://www.ucbi.com/business-banking/treasury-management/2026-nacha-rule-changes

**ABA routing number**
- 9 digits. The first two are 00 (US government), 01–12 (Federal Reserve districts), 21–32 (thrifts), 61–72 (electronic) or 80 (traveler's checks). Digits 5–8 identify the institution, and digit 9 is a check digit.
- **Checksum**: apply weights 3, 7, 1 repeating from left to right; the weighted sum must be ≡ 0 mod 10 (example: 021000021 sums to 30).
- Passing the checksum does not prove the bank exists, so also check the Fed E-Payments Routing Directory. Banks may use different ACH and wire routing numbers.
- https://commons.apache.org/validator/apidocs/org/apache/commons/validator/routines/checkdigit/ABANumberCheckDigit.html ; https://www.frbservices.org/EPaymentsDirectory/

**Wires and instant payments**
- **Fedwire** moved to **ISO 20022 on July 14, 2025** (structured addresses). Vendor records should hold structured addresses and beneficiary-bank details for wire exports. https://frbservices.org/news/communications/061825-fedwire-iso-go
- **RTP**: $10M per-transaction limit since Feb 9, 2025; supports Request for Payment. https://bankingjournal.aba.com/2024/12/rtp-network-to-raise-individual-transaction-limit-to-10m/
- **FedNow**: limit raised to **$10M in November 2025**. https://frbservices.org/news/press-releases/090525-fednow-transaction-limit-increase
- Integrate instant payments through bank or payment-provider APIs.

**Statement formats**
- **OFX/QFX/QBO**: QFX and QBO are OFX with an Intuit bank ID, and many US banks offer only QBO/QFX downloads. https://www.financialdataexchange.org/
- **BAI2** (now maintained by X9 as BTRS):
  - Records: 01 file, 02 group, 03 account and summary, 16 detail, 88 continuation, 49/98/99 trailers.
  - 3-digit type codes, for example 010/015 opening and closing ledger balance; detail codes for ACH, wires and checks paid.
  - Amounts have no decimal point, and banks use their own type-code variants.
  - https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0706020435.html
- **CSV**: varies by bank. Expect MM/DD/YYYY dates, either a signed amount or debit/credit columns, a check-number column and often newest-first order.
- **camt.053**: offered by large banks to corporates alongside BAI2; rare for SMBs. https://www.usbank.com/corporate-and-commercial-banking/treasury-payment-solutions/iso-20022.html

**What the software must do**
- Check engine: Letter voucher layouts, alignment offsets, MICR line for blank stock, amount in words, void/reprint tracking, signature thresholds, per-bank Positive Pay templates.
- Nacha generator: PPD/CCD/CCD+/CTX, prenotes, balanced or unbalanced output, same-day flag, PAYROLL enforcement, validation (checksum, hash, counts, padding).
- Controls for the fraud-monitoring rule: dual approval, vendor-bank-change verification with call-back, hold and prenote, anomaly flags.
- Bank imports: OFX/QFX/QBO, BAI2 with type-code maps, a CSV mapper with saved profiles, and camt.053 (reuse the NL parser).

## 10. E-invoicing in the US

- **No federal or state B2B e-invoicing mandate exists or has been announced.** There is no clearance model and no federally mandated invoice fields. PDF by email, customer AP portals (Coupa, Ariba) and EDI 810 in retail supply chains dominate. https://dddinvoices.com/learn/e-invoicing-usa-digital-business-networks-alliance
- **BPC → DBNAlliance**:
  - The Fed-supported Business Payments Coalition ran an e-invoice exchange pilot with 73 organizations.
  - The **Digital Business Networks Alliance** was launched in 2024 as the nonprofit that governs the resulting framework.
  - The model is Peppol-like: four corners, SML/SMP discovery and UBL documents. Businesses join through a member service provider.
  - https://fedpaymentsimprovement.org/news/press-releases/frs-bpc-announce-two-industry-efforts-propel-b2b-payments-toward-modernization/ ; https://tradeshift.com/resources/compliance/dbnalliance-vs-peppol-us-e-invoicing-network/
- **DBNAlliance in 2026**:
  - Live, voluntary and small. Named members include Chevron, ConocoPhillips, Microsoft, Halliburton and Weatherford.
  - It offers a Mass Adoption API for onboarding, and its specifications and a validator are on GitHub.
  - 2026 events: a New York conference on Apr 22 and a members' meeting on Sept 16.
  - Peppol interoperability is a goal, not yet in place.
  - https://dbnalliance.org/ ; https://www.peppol.nu/more-about-einvoicing/what-is-digital-business-network-alliance/
- **Federal customers**: OMB M-15-19 moved agencies to e-invoicing. Treasury's free **IPP** serves 228 agencies and more than 200,000 vendors (1.09M invoices in 2025); DoD uses PIEE/WAWF. https://fiscal.treasury.gov/system/files/1016/2026-08/2026-gws%20symposium-ipp.pdf
- **Invoice norms**:
  - Usual contents: seller and buyer, invoice number and date, PO number, terms ("Net 30", "2/10 Net 30"), due date, lines, subtotal, sales tax, total, and remit-to/ACH instructions.
  - The seller's EIN is optional; W-9s are exchanged instead.
  - Many states require or presume **separately stated sales tax**; the sales-tax research covers the details.

**What the software must do**
- A US invoice template (Letter, US dates, terms, remit-to block, ACH details, pay link) with early-payment discount terms.
- Keep the NL UBL/Peppol pipeline reusable, so a later DBNAlliance access-point partnership needs little new work.
- EDI 810 via partners.

## 11. Localization basics

- **Dates**: MM/DD/YYYY. Weeks usually start on Sunday. Fiscal years are named for the year they end in.
- **Paper**: **US Letter 8.5" × 11"**, with #10 and double-window check envelopes.
- **Money**: `$1,234.56`; negatives shown as `(1,234.56)` on statements; en-US locale.
- **EIN**: displayed as **XX-XXXXXXX**, with no check digit.
  - Valid prefixes: **01–06, 10–16, 20–27, 30–48, 50–68, 71–77, 80–88, 90–95, 98–99**.
  - Invalid prefixes: 00, 07–09, 17–19, 28–29, 49, 69, 70, 78–79, 89, 96–97.
  - Keep the prefix list as data.
  - https://www.irs.gov/businesses/small-businesses-self-employed/how-eins-are-assigned-and-valid-ein-prefixes
- **SSN**: AAA-GG-SSSS. Invalid if the area is 000, 666 or 900–999, the group is 00, or the serial is 0000. Since 2011, numbers are randomized and carry no geographic meaning. https://www.ssa.gov/employer/randomizationfaqs.html
- **ITIN**: 9XX-XX-XXXX, with the 4th–5th digits in 50–65, 70–88, 90–92 or 94–99 (ATINs use 93). ITINs expire after three years without use on a return. https://www.eitc.irs.gov/pub/irs-pdf/p4757.pdf
- **TIN protection**:
  - Payee statements may **truncate the payee TIN** to the last four digits (***-**-1234). Never truncate on IRS copies, the filer's own TIN, or a W-2G payee TIN. https://www.irs.gov/publications/p1099
  - Store TINs with field-level encryption and key management, mask them by default, allow role-based reveal with an access log, and keep them out of logs, search indexes, URLs and AI prompts.
  - Legal drivers: state breach-notification laws, and the **FTC Safeguards Rule (16 CFR 314)** for tax preparers and CPA firms (encryption, MFA, a written security program, and FTC notice within 30 days of a breach affecting 500 or more consumers, since May 13, 2024). https://www.federalregister.gov/documents/2023/11/13/2023-24412/standards-for-safeguarding-customer-information
- **States**: USPS codes for the 50 states and DC; territories PR, GU, VI, AS, MP; freely associated states FM, MH, PW; military AA, AE, AP. **ZIP**: `12345` or ZIP+4 `12345-6789`, stored as text (leading zeros). https://pe.usps.com/text/pub28/welcome.htm
- **Other**: +1 NANP phone numbers. Several time zones; Same Day ACH and IRS cutoffs are in Eastern Time.

**What the software must do**
- An en-US locale pack.
- Validators for EIN, SSN, ITIN, routing number, ZIP and state codes.
- A TIN vault (encryption, masking, reveal audit, truncation on recipient copies).
- A structured address model shared by sales tax, 1099s, checks and wires.

---

## Uncertain / please verify

1. **1099 threshold indexing**: the 2027 inflation-adjusted amount (base $2,000) is not yet published.
2. **New 1099-NEC boxes**: confirm that boxes 1b/1c/1d appear on the final 2026 form.
3. **Feb 15 recipient date for 1099-MISC boxes 8 and 10**: it comes from the Pub 1099 table and should be rechecked.
4. **Rev. Proc. 2025-32 penalty table**: it says "on or before August 1, 2026" for returns due in 2027, which looks like a typo for 2027.
5. **IRIS**:
   - CSV limit: IRS says 100 records per file; some vendors say 250.
   - How corrections work in IRIS for originals filed through FIRE.
   - Whether CF/SF participation in IRIS matches Pub 1220 Rev. 5-2026 (DC and PA status has been disputed; Missouri was removed).
   - Which states need direct filing.
6. **2025 §179 SUV cap**: Rev. Proc. 2025-32 removed the 2025 §179 section of Rev. Proc. 2024-40, so confirm the 2025 SUV cap ($31,300).
7. **Bonus depreciation**: Notice 2026-11 is interim, and §168(n) qualified production property guidance is still pending.
8. **§174A**: the small-business retroactive window closed on July 6 (one source says July 4), 2026. The transition dates in Rev. Proc. 2026-32 are Sept 21, Oct 21 and Nov 15, 2026.
9. **State gross receipts taxes**:
   - Oregon CAT threshold bills for 2026.
   - Washington SB 6346 details.
   - Ohio SB 450 (2026) and its effect on the CAT.
   - Whether Nevada commerce tax rates and Delaware exclusions are current.
10. **Nacha**: whether the proposed 4th Same Day ACH window (Sept 2026) was adopted. Also confirm each bank's balanced/unbalanced and Positive Pay specifications.
11. **TIN Matching daily limit**: IRS sources say 999 or 9,999 interactive requests per 24 hours.
12. **DBNAlliance**: membership numbers and the current specification version.
13. **Payroll APIs**: Gusto GL API version, and whether Rippling exposes a journal-entry API.
14. **camt.053 timing**: availability at US banks such as U.S. Bank (2026 vs 2027).
15. **1042-S for foreign contractors working abroad**: generally not required; confirm in Pub 515.
16. **SALT cap**: indexing for 2026 ($40,400?).
17. **June-30 fiscal-year C corps**: the transition to the 4th-month due date for tax years beginning after 2025.
