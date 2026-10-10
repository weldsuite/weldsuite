# How comparable products handle payroll, and what WeldHR should copy or avoid

Researched 8 October 2026. Sources are vendor product pages, pricing pages, help centers, developer docs, press releases and dated trade press. Several vendor sites (Gusto, Personio, Rippling and the HiBob UK help center) blocked automated fetching or rate-limited us, so a few facts come from search-indexed copies of those pages; the text says "as indexed" where that matters. "Third-party" marks claims from review sites, aggregators, competitors, job boards and forums. A, B and C are the approaches in the brief: **A** = payroll prep and export, **B** = embedded payroll provider, **C** = own engine.

## Summary

- **In the US, the suites closest to WeldSuite embed a provider instead of building.** Xero stopped building its own US payroll in 2018 and wrote off NZ$16.2m. It then ran a Gusto integration and launched an embedded "Xero Payroll powered by Gusto" in August 2026. Zoho has its own engine in India but uses Check for US calculation, filing and direct deposit. HiBob launched US payroll in September 2025 on Gusto Embedded. Only payroll-first companies (Intuit, Gusto, Rippling) run their own US engine, and they keep dedicated tax-notice teams.
- **The Netherlands has no Gusto- or Check-style embedded API.** HR suites answer NL with approach A. Personio built a Loket integration in 2025 and uses Nmbrs through a partner, and in both cases payslips flow back into the HR profile. HiBob and Factorial also rely on integrations. SnelStart and Moneybird have no payroll of their own; payroll tools push journal entries into them.
- **Dutch own-engine players are Exact and Employes.** Exact Online Salaris costs €92.50/month for 25 payslips and maintains about 140 CAOs. Employes was founded in April 2018 and ran its first payroll on its own engine in March 2019. It passed 5,000 customers in 2024 and was bought by Ageras/Shine in July 2025. Cegid then closed its acquisition of Shine in June 2026. In NL the trend is to bundle accounting with payroll by buying an engine.
- **HR suites rarely build an engine from scratch, and they add one country at a time.** Personio bought Rollbox in 2019 and shipped certified German payroll in 2023; Germany is still its only native country. BambooHR bought TRAXPayroll and stayed US-only. HiBob bought Pento for the UK. Deel bought PaySpace for its engines. Going from A to a native C took about four years where we could date it.
- **Odoo shows what a generic engine with thin localizations looks like.** Its US rules cover 19 states plus DC, and 941/940/W-2 come out as CSV files that a third party must e-file. The Dutch module is documented in one sentence and says nothing about loonaangifte. A third-party add-on fills that gap, but its output has to be re-keyed into filing software.
- **Pricing anchors.** In the US, payroll costs a $39–$50 base plus $6–$12 per employee per month (Zoho, QuickBooks, Gusto). In NL it is €5–€9 per payslip plus €25–€40/month at Employes, or about €3.70 per payslip inside Exact's bundle. UK payroll is nearly free inside Xero at £1–£1.50 per person. A third-party estimate puts embedded wholesale at a $35–$70 base plus $6–$10 per employee, with about two thirds kept by the platform (unverified).
- **Failure stories cluster around tax notices and slow support:** Gusto, QuickBooks, BambooHR and Zoho all have them (third-party). In one Zoho case the customer was not allowed to contact the embedded filing partner. In NL, a 2023 appeal court held a payroll administrator liable for €75k for not flagging a CAO error, so CAO interpretation carries real liability.
- **UX worth copying:**
  - HiBob's per-cycle change lists (new hires, changes, terminations, time off), with a sync status per record from the provider.
  - BambooHR's split between blocking and non-blocking pre-run errors.
  - QuickBooks' flags on unusual entries, with a human approving the run.
  - Rippling's optional auto-approval for stable payrolls.
  - Automatic journal posting and payslip delivery after a run at Exact and Employes.
  - Personio's Loket integration, which sends payslips back into the HR profile.

---

## 1. At a glance

| Product | US | NL | How they got there | Published payroll price |
|---|---|---|---|---|
| Zoho Payroll | B (Check) | none | Own engine in India/UAE; US on Check (Dec 2024); Canada, GCC (Dec 2025) | $39/mo + $6/employee (Standard, monthly) |
| Odoo Payroll | C, partial (19 states + DC, filings as CSV) | C, thin (module exists, filing not documented) | Built (Enterprise only) | Part of Enterprise; not checked |
| Exact Online Salaris | n/a | C | Own NL engine; bought Officient (HR) 2020 | €92.50/mo incl. 25 payslips |
| Xero | B (Gusto Embedded, Aug 2026) | none | Own UK/AU payroll; US build abandoned 2018 | UK £1–£1.50 per person |
| QuickBooks (Workforce) | C | n/a | Intuit's own engine | $88/mo + $6.50/employee bundled with Simple Start |
| Business Central | A (GL import) + ISV apps | A (Nmbrs connector) | Partners | n/a |
| SnelStart, Moneybird | n/a | A (journal entries pushed by payroll tools) | Partners | n/a |
| Personio | none | A (Loket, Nmbrs) | DE engine via Rollbox (2019), native 2023 | Not published |
| HiBob | B (Gusto Embedded, Sep 2025) | A (Payroll Hub/integrations) | UK engine via Pento (2024) | Not published |
| Factorial | none found | A (integrations + advisers) | No own engine found | Not published |
| BambooHR | C | A/partners/EOR | TRAXPayroll acquisition | Quote only |
| Rippling | C | Global payroll/EOR (NL not verified) | Built | Quote only (third-party: $8/user + base) |
| Gusto | C, also sells B | none | Built | Third-party: $49 + $6/person |
| Deel, Remote | Global payroll + EOR | Global payroll + EOR | Deel bought PaySpace (2024); Remote own engines in UK/CA | Remote $29/employee + fees |
| Employes by Shine | n/a | C | Built 2018–19; Shine 2025; Cegid 2026 | €7/payslip + €29.95/mo |

## 2. All-in-one business suites

### 2.1 Zoho (Zoho Payroll)

- **Countries and order.** India and the UAE came first. The US launch post (12 December 2024) says the product covers "all 50 states" (https://www.zoho.com/blog/payroll/payroll-software-for-usa.html). Multi-state US payroll followed on 28 May 2025, Canada on 2 December 2025 and the GCC on 10 December 2025 (https://www.zoho.com/blog/payroll).
- **The US engine is Check's, not Zoho's.** Zoho's US help center calls Check "a payroll-as-a-service API provider". It says Check handles "calculating payroll amounts and tax liabilities", "filing and paying payroll taxes electronically", direct deposit, and garnishments for some agencies (https://www.zoho.com/us/payroll/kb/employer/general/about-check.html). So Zoho is C in India and B in the US.
- **Pricing (US).**
  - Standard costs $39/month + $6 per employee ($29 + $5 billed annually). It covers single-state payroll, federal/state/local filing, direct deposit and employee self-service.
  - Professional costs $59 + $8.50 ($49 + $7 annually). It adds multi-state payroll, bonus pay runs, pay run approvals and custom roles.
  - Pass-through fees: $150 per amended return, $150 per delayed filing, $8 per failed employee payment and $3 per mailed W-2 (https://www.zoho.com/us/payroll/pricing/).
- **Operating rule.** Zoho files and pays "as long as your payrolls are approved on time", and it keeps a separate list of unsupported taxes (https://www.zoho.com/us/payroll/kb/employer/taxes-and-forms/tax-filings-in-zoho-payroll.html). It connects natively to Zoho Books, Expense and Practice (launch post above).

Implication for WeldSuite: Zoho is the closest analog: a multi-app suite that, like WeldBooks, covers India and the US. Zoho already owned a payroll engine, yet it chose B for the US. It also puts approvals and multi-state payroll in the higher tier and passes the provider's exception fees through to customers.

### 2.2 Odoo (Payroll app)

- **Localizations.** The 19.0 docs list 23 payroll localizations, including the Netherlands and the United States. Each needs its country module installed (https://www.odoo.com/documentation/19.0/applications/hr/payroll/payroll_localizations.html). Payroll is an Enterprise app; Community users rely on the OCA backport (https://github.com/OCA/payroll).
- **US: Odoo calculates, but filing stops at CSV.**
  - Coverage. Federal income tax, FICA and unemployment are covered by default. State rules exist for Alabama, Arizona, California, Colorado, Florida, Georgia, Idaho, Illinois, Iowa, Mississippi, Nevada, New Jersey, New York, North Carolina, Oregon, Texas, Vermont, Virginia, Washington and DC. The state follows the employee's work address.
  - Filing. W-2, 941 and 940 are produced as CSV files, which the company must "submit … through a third party for e-filing".
  - Payments. An ADP export CSV lets ADP pay employees. Odoo can also generate a NACHA file from a trusted bank account.
  - Accounting. An optional accounting module creates journal entries per payslip (https://www.odoo.com/documentation/19.0/applications/hr/payroll/payroll_localizations/united_states.html).
- **NL: a module with almost no documentation.** "Netherlands - Payroll" (`l10n_nl_hr_payroll`) is described only as "Dutch-specific payroll rules including employee details, passport-based contracts, etc." It ships with an accounting companion, `l10n_nl_hr_payroll_account` (https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/netherlands.html). The Netherlands card on the localization page has no documentation page of its own, and nothing mentions loonaangifte.
- **Third parties fill the NL gap.**
  - Pokutsoft's `l10n_nl_loonaangifte` (€205 for v19) computes loonheffing, credits, employer premiums and Zvw. Its periodic return is not in the Belastingdienst message schema, so users copy the figures into their own filing software and submit with their own certificate. The listing does not mention CAOs (https://apps.odoo.com/apps/modules/19.0/l10n_nl_loonaangifte).
  - KJ Software's Nmbrs connector (€250/year, Enterprise only) pulls payroll journal entries from Nmbrs into Odoo. That is approach A (https://apps.odoo.com/apps/modules/19.0/connect_nmbrs).
- **Inputs.** Odoo 19 payroll computes payslips from "work entries" (attendance and time off) and maps the results to accounting journals (third-party guide: https://octurasolutions.com/resources/odoo-19-payroll-setup-salary-rules-structures-and-automated-payslip-generation).

Implication for WeldSuite: a generic rule engine with per-country rule packs looks cheap, but the hard parts land on partners or on the customer: filing, CAOs and full state coverage. If WeldSuite chooses C, filing has to be in scope from the first release. Otherwise customers end up re-keying, as Odoo's NL users do.

### 2.3 Exact Online (NL)

- **Own NL engine (C).** Exact Online Salaris costs €92.50/month for 25 payslips. The bundle can be changed every month, and the employee self-service app is free (https://www.exact.com/nl/bedrijven/salaris/features-en-prijzen). Extra payslips cost €7 each, or €3.50 if you raise the bundle. Exact keeps "about 140" CAOs up to date (another page says 150+) and handles payment files plus wage tax and pension filings. Salaris requires Boekhouden Plus, Professional or a sector package (https://www.exact.com/nl/producten/salaris/salarisadministratie, as indexed). The edition for accounting firms costs €55/month for 50 payslips (https://www.exact.com/nl/producten/accountancy/salaris/features-en-prijzen).
- **Scale.** A 2019 Exact presentation claimed more than 150 CAOs, more than 50,000 users and more than 343,000 payslips (https://files.exact.com/static/nl/exact-live/2019/pdf/De%20innovaties%20in%20Salaris%20in%20Exact%20Online.pdf).
- **UX.**
  - Alerts flag CAO changes and age-based pay steps.
  - The closed payroll posts to the books automatically.
  - Roles are split: employees see their own data, employers enter changes and authorise payments, and payroll administrators check the records.
  - Employees get payslips and annual statements (jaaropgaaf) in the app and request leave there (same 2019 deck).
- **HR came after payroll.** Exact bought the Belgian HR SaaS Officient (4,000 customers) on 24 September 2020 (https://www.consultancy.eu/news/5096/exact-acquires-belgian-hr-cloud-software-provider-officient). Exact Officient costs €7.90 per employee/month with a minimum of 5 (https://www.exact.com/nl/software/exact-officient, as indexed).

Implication for WeldSuite: Exact is the incumbent bundle in NL, combining accounting and payroll at roughly €3.70 per payslip inside the bundle. It competes on CAO coverage and on the accountant channel, which gets a cheaper edition.

### 2.4 Xero

- **Own payroll in the UK and Australia, priced as part of the plan.** UK plans include payroll for 1 person (Grow), 5 (Comprehensive) or 10 (Ultimate), with each extra person at £1.50, or £1 on Ultimate (https://www.xero.com/uk/pricing-plans/). AU plans include 2, 5 or 10–100 people (https://www.xero.com/au/pricing-plans/).
- **US: Xero tried C, fell back to A, then moved to B.**
  - 2018. In July 2018 Xero stopped building its own US payroll and took a NZ$16.2m non-cash impairment. It made Gusto its preferred US provider. The reasons it gave were per-state tax requirements and the difficulty of reaching US accountants (https://www.fool.com.au/2018/07/20/xero-limited-changes-tack-in-the-u-s/).
  - 2024. In December 2024 the two companies expanded the partnership into an embedded product (https://report.woodard.com/articles/xero-to-launch-all-in-one-simple-payroll-fpwr).
  - 2026. "Xero Payroll powered by Gusto" launched on 20 August 2026. It offers unlimited runs, direct deposit, contractor payments, federal/state/local filing, benefits calculations and employee self-service (https://cfotech.news/story/xero-unveils-us-payroll-payments-push-with-gusto).
- **Dependency risk (third-party).** A status aggregator lists incidents in which US payroll in Xero was unavailable or slow because of problems on Gusto's side (https://isdown.app/status/xero/incidents/661941-us-payroll-powered-by-gusto-customers-will-be-unable-to-access-us-payroll-in-xero).

Implication for WeldSuite: this is the clearest C-to-A-to-B story in the set. It took eight years from dropping C in 2018 to shipping B in 2026. Xero owns its engines only where payroll tax is national and simple (UK RTI, AU STP).

### 2.5 QuickBooks (Intuit)

- **Own US engine (C), now called QuickBooks Workforce.** Payroll Core, Premium and Elite became Workforce Payroll, Premium and Elite. Base prices stayed the same, and the per-employee fees changed on 1 July 2026. A Benefits Administration add-on costs $5 per employee per month for companies with 20 or more employees (https://www.firmofthefuture.com/product-update/quickbooks-payroll-price-changes/).
- **Bundles on the pricing page:**
  - Workforce Payroll + Simple Start: $88/month + $6.50 per employee, with next-day direct deposit.
  - Workforce Payroll + Essentials: $125 + $6.50, with same-day direct deposit.
  - Workforce Premium + Plus: $203 + $10, with same-day direct deposit and time tracking.

  The page shows a 50% discount for three months (https://quickbooks.intuit.com/payroll/pricing/).
- **The penalty guarantee is only on the top tier.** Elite reimburses penalties and interest up to $25,000 a year. Coverage starts after an expert setup review, and the notice must be sent within 15 days (https://quickbooks.intuit.com/payroll/tax-penalty-protection/).
- **AI review step.** The payroll agent flags unusual entries, for example an employee's first overtime, for the admin to confirm or override. Final approval stays with a person, and an activity log records what the agent did (https://www.firmofthefuture.com/quickbooks-proadvisor/in-the-know-s4-e8-payroll-agent/).

Implication for WeldSuite: this is the US benchmark that WeldBooks US customers will compare against, and it comes bundled with accounting. Intuit sells penalty protection as a premium-tier feature.

### 2.6 Microsoft Dynamics 365 Business Central

- **No native US or NL payroll; payroll comes in through a journal import.** Microsoft's Ceridian extension imports aggregated payroll transactions from Ceridian HR/Payroll (US) and PowerPay (Canada) into the General Journal, maps the external accounts to G/L accounts and posts them (https://github.com/MicrosoftDocs/dynamics365smb-docs/blob/main/business-central/ui-extensions-ceridian-payroll.md). A QuickBooks payroll file import works the same way.
- **Partner apps.** Release wave 1 of 2023 lets users discover payroll apps from inside Business Central in selected countries (https://azurecurve.co.uk/2023/02/new-functionality-in-microsoft-dynamics-365-business-central-2023-wave-1-easily-find-and-install-payroll-apps-from-within-business-central). US partner apps include:
  - Greenshades, with bi-directional sync (https://go.greenshades.com/payroll-for-bc-users).
  - Payroll NOW by Integrity Data, embedded US/Canada payroll (https://dynamicscommunities.com/ug/introducing-payroll-now-by-integrity-data-embedded-payroll-for-business-central/).
  - Primo Payday, written in AL (https://velosio.com/blog/integrated-payroll-for-microsoft-dynamics-365-business-central).
- **NL.** Nmbrs lists a Business Central (on-premises) connector (https://appstore.nmbrs.com/s/business-central-on-premises).

Implication for WeldSuite: an ERP can live on approach A for years if it has a good GL import and a partner ecosystem. Microsoft's minimum is a summarized payroll journal import with account mapping. WeldBooks should have that in any case.

### 2.7 SnelStart and Moneybird (NL bookkeeping)

- **No payroll of their own that we could find.** Payroll tools post into them. Employes' integrations create the payroll journal entries automatically in SnelStart and in Moneybird, and Moneybird advisers get free access to Employes (https://employes.nl/en/integrations/snelstart/ ; https://employes.nl/en/integrations/moneybird/).
- **SnelStart access is gated.** Custom connections are only available on the higher packages (inZicht, inControle), and a permanent key requires SnelStart to certify the integration (third-party: https://developers.apideck.com/apis/accounting/snelstart/connection).

Implication for WeldSuite: Dutch bookkeeping tools treat payroll as a journal entry imported from a specialist, so that is the minimum NL customers expect. Shine and Cegid instead own the bundle (section 3.8).

## 3. HR suites and payroll specialists

### 3.1 Personio

- **Native (C) only in Germany.** Personio bought Rollbox in April 2019, a Spanish API-based payroll company active in Spain, the UK and Germany, with the plan of building "a fully integrated payroll engine" (https://techcrunch.com/2019/04/09/personio-rollbox). Its ITSG-certified German payroll launched in 2023, and more than 1,000 businesses used it by January 2025. That month Personio added a "Payroll Expert Plan" that brings tax advisers into the process (https://www.personio.com/about-personio/press/payroll-expert-plan/, as indexed). The product page says it is "currently only available in Germany" (https://www.personio.com/product/personio-payroll/, as indexed).
- **UK: integration with Xero (A), 31 July 2024.** The integration sends employee records, fixed pay, one-off and recurring payments and custom pay periods to Xero; absences were "coming soon". Payroll itself runs in Xero (https://www.businesswire.com/news/home/20240731404258/en/Personio-Announces-Xero-Integration-to-Enable-Seamless-Payroll-Cycles-for-UK-Customers).
- **NL: integrations with Loket and Nmbrs (A).**
  - Loket. Personio built the Loket integration itself. It was announced on 20 February 2025, and one-click transfer of employee and compensation data started at the end of March 2025, with payslips returned to Personio (https://www.personio.com/about-personio/press/partnership/loket/). It requires a Dutch legal entity (https://support.personio.de/hc/en-us/articles/34406718265373-Overview-of-the-Loket-integration).
  - Nmbrs. The Nmbrs integration is run by the partner worldofwork. Bank details, fixed salary and personal data go to Nmbrs, payslips come back, and the integration also provisions and deprovisions employees (https://support.personio.de/hc/en-us/articles/14951759607197-Nmbrs-by-worldofwork).

Implication for WeldSuite: it took four years from buying an engine to a certified native payroll, and that payroll covers one country. A large European HR suite answers the Netherlands with approach A. The Loket integration (data out, payslips back) is the pattern to copy.

### 3.2 HiBob

- **A everywhere: Payroll Hub.**
  - For each pay cycle, Bob shows a New employees report, an Employee changes report and a Termination report. The admin reviews each one and presses "Sync all" for each payroll system before the cycle ends.
  - Named connectors are ADP Workforce Now, Cloudpay and Paylocity. "Payroll Connect" links any other system, with report fields renamed to that provider's terms (https://www.hibob.com/blog/payroll-hub/).
  - Provider side: webhooks fire for new hires, changes, terminations and time off. The provider pulls the sync records and must mark each record synced or failed. Each request expires after 2 minutes, and every status update extends it by another 2 minutes (https://apidocs.hibob.com/docs/integrate-with-bob-payroll-hub).
- **C in the UK through an acquisition.** HiBob bought Pento, a UK and Danish payroll company with 400+ UK customers, in February 2024. The price was undisclosed; press estimated about $40m (https://tech.eu/2024/02/13/tiger-global-backed-pento-acquired-by-israeli-hr-platform-hibob/). The UK payroll product has its own help center with approval flows (https://ukpayroll.hibob.com/hc/en-us/articles/30386645271825-Add-approval-flows).
- **B in the US.** HiBob announced "native" US Payroll and Benefits Administration on 16 September 2025, "powered by Gusto Embedded Payroll". The launch included AI answers to payslip questions (https://techintelpro.com/news/hr/payroll-and-benefits/hibob-launches-us-payroll-and-benefits-solution).

Implication for WeldSuite: HiBob chooses per country. It bought C where a good engine was for sale (UK), embedded B in the US and used A everywhere else. Payroll Hub is the best approach-A design in this set: change lists per cycle, record-level acknowledgement from the provider, and time off as its own sync type.

### 3.3 Factorial

- **Mostly A, plus a network of payroll advisers.**
  - An FAQ on a Factorial preproduction domain says "Factorial does not calculate your payroll, it helps and guides you through" (https://eu2.preproduction.factorialhr.com/payroll).
  - The live page lists bonuses with manager approval, overtime calculation, payment files and bulk payslips. Certified consultancies can calculate, review and validate payroll (https://factorialhr.com/payroll).
  - Factorial integrates with 25 payroll systems, including a3innuva, DATEV LODAS and Silae. Customers without a connector can use a generic export or the API (https://factorialhr.com/apps/category/146390751-Payroll).
- **Spain is the exception.** The Spanish page says Factorial automates calculations and IRPF, paired with a certified gestoría (https://factorial.es/nominas). A Factorial engineering job ad says "We don't calculate payroll ourselves, but we enable all the actors around the process" (third-party job board, undated: https://careers.factorialhr.com/job_posting/senior-staff-software-engineer-payroll-time-domain-38310).

Implication for WeldSuite: approach A plus partner payroll advisers can be a lasting business model rather than a stopgap.

### 3.4 BambooHR

- **Own US engine (C).** BambooHR Payroll is "designed to pay US-based employees". For other countries BambooHR points to local payroll integrations, global payroll partners or an EOR. It files federal, state and local taxes and creates W-2s. Tracked time "flows effortlessly into payroll" and PTO syncs. Managed Payroll is described as "You review and approve. We handle the execution." The page lists no price, only a demo request (https://www.bamboohr.com/payroll/).
- **Origin: the TRAXPayroll acquisition.** BambooHR moved the TRAXPayroll help center into its own (https://www.bamboohr.com/product-updates/updates-to-the-traxpayroll-help-center). A breach record from February 2019 already ties TraxPayroll to Bamboo HR LLC (third-party tracker: https://blog.rankiteo.com/bam918072825-bamboo-hr-llc-breach-february-2019/). A rebuilt payroll experience followed on 12 September 2023 (https://www.bamboohr.com/about-bamboohr/press-release/new-bamboohr-r-payroll-experience-offers-fast-accurate-paychecks-eliminates).
- **Pre-run checks.** Company errors appear in red and block the run: missing addresses, job locations or company bank details, and overlapping records. Employee errors appear in an orange banner and stop blocking once that employee is removed from the cycle (https://www.bamboohr.com/product-updates/surfacing-data-errors-and-issues-in-bamboohr).

### 3.5 Rippling

- **Own US engine (C), plus global payroll.** Global payroll runs through Rippling's own entities (EOR) or through the customer's entities. The page says "Rippling instantly calculates and files payroll taxes for your employees worldwide" but publishes no country count (https://www.rippling.com/global-payroll). Rippling job ads describe the global payroll products as "natively built", and they also mention external partners in some countries (third-party job board: https://careers.threshold.vc/companies/rippling/jobs/31591481-global-payroll-solutions-consultant).
- **Operations.** A Workflow Automator template alerts payroll admins when automatic approval of a pay run fails. Rippling positions auto-approval for companies whose payroll changes little from run to run (https://rippling.com/recipes/payroll-auto-approval-failure-alert, as indexed). Rippling also staffs a payroll tax notice team that traces notices back through internal systems and works with Payroll Engineering to close the gaps (https://ats.rippling.com/rippling/jobs/eeb76f1d-e436-4426-b68f-80f9553f89a6).
- **Pricing is quote-only.** Third parties cite $8 per user/month plus a base fee of about $35–$40. Vendr reports a median contract of about $40k a year (third-party: https://www.gloroots.com/blog/rippling-price).

Implication for WeldSuite: running C in the US means keeping a standing team for tax notices, not just an engine.

### 3.6 Gusto and Gusto Embedded

- **Own US engine (C), also sold to other platforms as B.** By December 2024 Gusto Embedded had processed $1.3bn of payroll for partners' customers since its launch about three years earlier, and two of the top five US banks used it (https://report.woodard.com/articles/xero-to-launch-all-in-one-simple-payroll-fpwr). Partners include Xero (2.4) and HiBob (3.2). U.S. Bank's payroll product, launched in September 2025, runs on Gusto (third-party: https://sacra.com/research/gusto).
- **Direct prices (third-party; gusto.com blocked fetching).** Simple is $49 + $6 per person, Plus $80 + $12, Premium $180 + $22 or custom, and Contractor Only $35 + $6 (https://www.noon.ai/blog/articles/317-gusto-pricing-2026). There is no public wholesale price for Embedded. A generic estimate for embedded payroll is a $35–$70 base plus $6–$10 per employee, with the platform keeping about two thirds (third-party, not Gusto-specific: https://www.banq.ai/embedded-finance/category/payroll).
- **Filing exceptions push work back to the customer.** After three failed filings, the business has to file outside Gusto. Placeholder tax account numbers lead to wrong payments, and the business pays the resulting penalties (https://support.gusto.com/article/241007175509330/Fix-tax-filing-payment-and-account-errors-in-Gusto-for-admins, as indexed).
- **The other large embedded provider is Check.** It lists Wave, Eddy, 7shifts, Miter, Playground, Homebase, Warp and Dripos as partners (https://www.checkhq.com/partners), and Zoho uses it too (2.1). Check offers white-label "Run Payroll" and onboarding components (https://docs.checkhq.com/).

### 3.7 Deel and Remote (EOR first, payroll second)

- **Deel.** Deel announced the PaySpace acquisition on 5 March 2024. PaySpace had engines in 44 countries and 14,000 customers, and Deel said it went "from two engines to five engines, and now to more than 50" (https://gpa.net/blogs/global/global-deel-acquires-payspace-and-crosses-500m-in-arr). The reported price was about $100m (https://en.globes.co.il/en/article-1001472891). In October 2025 Deel raised $300m and set a target of native payroll in more than 100 countries by 2029 (https://www.peoplematters.in/news/funding-and-investment/deel-raises-dollar300m-to-build-native-payroll-in-100-countries-by-2029-46896).
- **Remote.** Its own engines are "already live in key markets like Canada and the UK". It supports more than 100 countries, but hourly workers only in "select major markets" (6 May 2025: https://remote.com/news/remote-expands-ai-driven-payroll-to-100-countries-giving-teams-a-faster). Payroll costs $29 per employee/month plus implementation and recurring delivery fees, and EOR costs $699 (https://remote.com/pricing).

Implication for WeldSuite: EOR is a different business, because the vendor becomes the legal employer. It doesn't fit agencies that employ their own staff. These companies still show that "global payroll" mostly means partners, with own engines in only a few countries.

### 3.8 Employes (now "Employes by Shine", part of Cegid)

- **Own NL engine (C), built from scratch by a small team.**
  - April 2018: founded.
  - March 2019: launched its "self-developed payroll engine" and paid its first 300 customers.
  - October 2024: more than 5,000 customers.
  - July 2025: joined Shine (https://employes.nl/en/about-us/). Shine was then called Ageras (third-party job listing: https://thehub.io/jobs/6abc511eb6e7a316d0319af6).
  - In 2023 the company had 10–20 FTE and €1–5m in revenue (third-party: https://mtsprout.nl/ranking/saas100-2023/bedrijf/employes).
- **Cegid now owns it.** Cegid announced its purchase of Shine on 26 November 2025 and closed it on 8 June 2026 (https://www.joplinglobe.com/region/national_business/cegid-closes-acquisition-of-shine-to-create-europes-first-complete-ai-driven-platform-for-smbs/article_5a0adda7-e37d-5ac8-bee7-151d4626fdda.html). Les Echos reported a price above €1bn (third-party: https://www.maddyness.com/2025/11/26/shine-18-mois-apres-son-rachat-par-ageras-la-fintech-bascule-dans-le-giron-de-cegid/).
- **Pricing is per payslip:**
  - Payroll: €7 per payslip + €29.95/month.
  - Payroll & HR: €9 + €39.95.
  - Accountancy: €5 + €25, with 10–20% volume discounts.
  - DGA plan: €16.50/month.
  - Time registration: €2 per employee.

  Every plan files the loonaangifte and the pension fund declaration after each run, and CAOs are built in (https://employes.nl/en/pricing/).
- **Pay run in five steps:** invite employees, enter hours, bonuses and expenses, approve "in one click", pay out with generated payslips and a payment file, and let the tax filing go out automatically. Shine claims 7,500+ businesses (https://shine.co/en-nl/payroll). Journal entries go to SnelStart, Moneybird or Shine's own accounting (https://employes.nl/en/integrations/shine/).

Implication for WeldSuite: a team of about 10–20 people built and ran an SMB Dutch engine, with the first payroll about 11 months after founding. A pan-European accounting and banking platform then bought it instead of building one. Employes also uses accountants as a sales channel (accountant plan, volume discounts, free adviser access). Because Cegid now owns it, a white-label deal with Employes is less likely; we have not asked.

### 3.9 The NL and BE ecosystem: Officient, Loket, Nmbrs, Easyflex

- **Officient (BE).** Officient connects to many Belgian social secretariats and to similar providers in the Netherlands and Luxembourg. Exact bought it in September 2020 (https://www.dutchitchannel.nl/news/161025/exact-neemt-leverancier-hr-cloudsoftware-officient-over). Securex resells it as Exact Officient, and changes flow to the secretariat automatically (https://www.securex.be/en/personnel-policy/officient). This is approach A in its Belgian form: the social secretariat does the calculation.
- **Loket.nl API.**
  - Partners send actuals per payroll period (hours worked, travel allowance, meal allowance and other components) through the Payroll Period Data resource.
  - They create "concept employees" (job applicants) that the payroll accountant completes and converts in Loket.
  - They can read payroll results, journal runs and payslips.
  - Login uses OAuth2 SSO. Permissions are checked per employer, and Loket does not hand out production credentials (https://developer.loket.nl/guidelines.md).
- **Nmbrs (Visma).** Developer portal with subscription keys, partner onboarding via a form (https://developer.payroll.nmbrs.com/docs). Third-party listing: from €49/month for 10 employees plus €2.99 per additional employee (https://www.softwareadvice.com/hr/nmbrs-profile/).
- **Easyflex (staffing).** Easyflex is payroll software for the staffing sector ("De software voor de uitzendbranche"). It also handles hours, including Excel timesheet import, and invoicing. Nearly 1,500 staffing agencies use it, and the company has existed for almost 25 years (https://www.easyflex.nl/). Under the ABU and NBBU CAOs, temps are entitled to the same pay as the client's own staff in the same role (third-party: https://webwoordenboek.nl/kenniscentrum/wat-is-abu-en-nbbu).

Implication for WeldSuite: in NL, approach A means integrating with the Loket and Nmbrs APIs. Both accept hours per period and return results and journals. Agencies' payroll runs on staffing-specific software that also bills the client, so WeldHR's client-assignment data is a natural input to export.

## 4. Pay run UX patterns across products

- **Draft, review, approve, submit.**
  - Employes/Shine: enter variable inputs, then approve in one click, after which payslips, the payment file and the filing are generated (3.8).
  - Bullhorn Back Office: payroll records start "In Progress" and must be approved before they can be exported (https://kb.bullhorn.com/backoffice/Content/backoffice/Topics/exportingPayroll.htm).
  - Zoho: pay run approvals only in Professional (2.1).
  - HiBob UK: configurable approval flows (3.2).
  - Rippling: optional auto-approval with an alert when it fails (3.5).
- **Checks before the run.** BambooHR blocks the run on company errors and only warns on employee errors (3.4). QuickBooks flags first-time or unusual entries for confirmation (2.5). Exact raises alerts on CAO and age-based changes (2.3). No primary source we reached documents a run-to-run variance report. QuickBooks' and Exact's checks are the closest, and the comparison of two pay runs exists as a standard report elsewhere (Employment Hero: https://help.employmenthero.com/hc/en-au/articles/360001381676-Create-a-variance-and-audit-report-within-a-pay-run-on-payroll-classic).
- **Time and leave as inputs.**
  - HiBob sends time off as its own sync type, keyed by employee, effective date and request id (3.2).
  - Loket takes hours and allowances per payroll period (3.9).
  - BambooHR passes tracked hours and PTO to payroll (3.4).
  - Odoo computes from work entries (2.2).
  - Personio's UK link to Xero shipped without absences (3.1).
- **Payslips, self-service and year-end.**
  - Exact gives employees payslips and annual statements in an app (2.3), and Personio pulls Loket and Nmbrs payslips into the employee profile (3.1).
  - On the US side, BambooHR includes W-2s (3.4), Zoho charges $3 to mail a W-2 (2.1), and Odoo only produces a W-2 CSV (2.2).
- **GL posting.** Exact posts automatically when the payroll closes (2.3). Employes pushes journal entries to SnelStart, Moneybird and Shine (2.7, 3.8). Odoo creates entries per payslip (2.2). Business Central imports a summarized journal with account mapping (2.6). Loket exposes journal runs (3.9).

## 5. Complaints and failure stories (third-party)

- **Gusto.** Trustpilot shows 2.5/5 from about 2,000 reviews, rated "Poor"; the recurring complaint is slow support when a tax notice or a benefits error needs fixing (https://www.trustpilot.com/review/gusto.com?page=9). In October 2022, Colorado's Treasury said Gusto had emailed clients wrong instructions about unemployment premium filings, and more than 100 business owners contacted the Treasury within two days (https://treasury.colorado.gov/press-release/10192022-payroll-firm-gusto-sends-colorado-businesses-incorrect-information-for-tax).
- **QuickBooks.**
  - Capterra's summaries count 73% negative mentions of phone support (45 reviews) and 65% negative mentions of technical and sync problems (110) (https://capterra.com/p/174981/QuickBooks/reviews/).
  - An April 2026 community thread describes a Texas Q1 2026 unemployment return that was auto-filed in January and then rejected; amending it was not possible on Core. In the same thread, a blocked New York filing was closed as "working as designed" (https://quickbooks.intuit.com/learn-support/en-us/employees-and-payroll/payroll-tax-filing-error/00/1609709).
  - A June 2026 post complains that the Elite per-employee fee rose by more than 50% (https://quickbooks.intuit.com/community/other-questions-9/price-increase-for-workforce-374675).
- **BambooHR.** Capterra's roll-up marks 42% of 314 reviews negative on payroll integration and flexibility and 44% of 216 negative on pricing. A March 2023 reviewer reported W-2 errors still unresolved after almost two months, with no phone access (https://capterra.com/p/110968/BambooHR/reviews/).
- **Zoho Payroll US.** A Capterra review dated 18 May 2026 says monthly state reports were not filed, Q1 forms and 941s were still missing two months into the next quarter, and earnings were misreported. Emails took 7 days to answer. Zoho blamed "the US company that takes care of the reporting and tax payments" and would not let the customer speak to them (https://www.capterra.com.au/software/186299/zoho-payroll). A G2 reviewer says customization is limited for complex pay structures (https://g2.com/products/zoho-payroll/reviews).
- **Odoo.** On an older forum thread (Odoo 13), a community member said stock payroll probably did not calculate Connecticut taxes and suggested writing custom Python salary rules (https://www.odoo.com/forum/help-1/odoo-13-payroll-app-160527).
- **NL liability.**
  - The case: the Court of Appeal 's-Hertogenbosch (11 July 2023, ECLI:NL:GHSHE:2023:2250) held a payroll administration firm liable for €75,143.76. The employer had kept paying a CAO supplement that had lapsed in 2013, and the firm never flagged it (https://www.salarisvanmorgen.nl/2023/07/21/meer-salaris-betaald-dan-cao-vereist-administratiekantoor-aansprakelijk/).
  - Why it matters: this is not a software complaint, but it sets the duty of care a Dutch payroll processor carries on CAO interpretation.
- **Employes.** Trustpilot shows 4.7 from 598 reviews, with 1- and 2-star reviews each under 1%. We found no recurring complaint (https://ca.trustpilot.com/review/employes.nl).
- **"Missing CAO support" in NL.** We found no verifiable complaints of this kind about a named product; see "Could not verify".

## 6. Lessons for WeldSuite

### 6.1 Who started where, and how long the move to C took

| Company | Path | Time to native C |
|---|---|---|
| Xero (US) | C attempt dropped 2018 → A (Gusto integration) → B (announced Dec 2024, live Aug 2026) | Never; 8 years to B |
| Personio (DE) | A → bought Rollbox Apr 2019 → certified native payroll 2023 | ~4 years, one country; NL and UK still A |
| BambooHR (US) | A → bought TRAXPayroll (by early 2019) → rebuilt payroll Sep 2023 | ~4 years to an integrated product |
| HiBob | A (Payroll Hub) → bought Pento Feb 2024 (UK) → B in US Sep 2025 | Bought, not built |
| Zoho | C in India/UAE → B (Check) for US Dec 2024 | Own engine not extended to US |
| Shine/Ageras → Cegid | Bought Employes Jul 2025 | Bought |
| Deel | EOR via partners → 2, then 5 engines → bought PaySpace 2024 (50+) | Bought; target 100+ by 2029 |
| Remote | EOR → own engines in UK and Canada by 2025 | Built, a few countries |
| Employes | C from scratch | ~11 months to first run (NL SMB only) |
| Factorial | A + adviser network | No own engine found |

Patterns:

1. **No HR or accounting suite in this set built its own US engine and kept it.** They bought one, embedded one, or gave up (Xero). The companies with their own US engines are payroll-first businesses that staff tax-notice teams (Rippling, Gusto, Intuit).
2. **Own engines arrive one country at a time, usually by acquisition, and slowly.** Seven years after buying Rollbox, Personio is native in Germany only.
3. **A is a durable product in its own right.** It is the NL answer of Personio and HiBob, Factorial's main model and Business Central's default.
4. **NL has no embedded provider like Gusto or Check.** In practice "B" in NL means a deep A integration with Loket or Nmbrs, or owning or partnering with an NL engine as Shine did with Employes.
5. **NL accounting and payroll are consolidating:** Exact owns both, and Cegid now owns Shine plus Employes. WeldSuite's natural NL competitors are Exact Online with Salaris, and Shine with Employes.

### 6.2 Pricing and attach rates

| Market | Benchmarks |
|---|---|
| US | Zoho $39 + $6 PEPM; QuickBooks $88 + $6.50 (bundle); Gusto $49 + $6 (third-party); Rippling ~$8 + base (third-party) |
| NL | Employes €7–€9/payslip + €29.95–€39.95/mo; Exact €92.50/mo for 25 payslips; Nmbrs from €49/mo for 10 (third-party) |
| UK, AU (own engine, national tax) | Xero £1–£1.50 per person, payroll included in plans |
| Global | Remote $29 PEPM + fees |

- Dutch pricing is per payslip and US pricing per employee per month. WeldSuite should follow each market's convention.
- The B margin in the US is thin if the wholesale estimate holds: a $35–$70 base plus $6–$10 per employee against retail of $39–$50 plus $6–$12. Zoho protects its margin by passing exception fees through (2.1).
- No vendor publishes payroll attach rates. The only indirect data points: more than 1,000 Personio Payroll customers about two years after its German launch (3.1), and $1.3bn of payroll through Gusto Embedded in about three years (3.6).

### 6.3 Copy

- **HiBob Payroll Hub as the approach-A model.**
  - A change list per cycle: new hires, changes, terminations and time off.
  - A sync status per record from the provider.
  - Field names mapped to the provider's own terms.
- **The Loket write pattern.** Push hours and allowances per payroll period, create "concept employees" for the payroll accountant to complete, and read payslips and journal runs back.
- **Pre-run checks.** Blocking errors versus warnings, with "remove from this cycle" as the way out (BambooHR). Flags on unusual entries with a person approving (QuickBooks). An optional auto-approval for stable payrolls, with an alert when it fails (Rippling).
- **After the run.**
  - Automatic GL journal entries (Exact, Employes).
  - A payment file: SEPA in NL, NACHA in the US.
  - Payslips and the jaaropgaaf or W-2 in self-service, and payslips returned into the employee's HR profile even under approach A (Personio with Loket).
- **Commercial levers.** Approvals and multi-state as higher-tier features, and exception fees passed through (Zoho). An accountant edition with volume discounts (Exact, Employes).

### 6.4 Avoid

- **Calculation without filing:** CSV files for someone else to e-file, partial state coverage, and a Dutch module documented in one line (Odoo).
- **An embedded provider the customer can't see behind.** In the Zoho complaint the customer could not reach the filing partner. If WeldSuite chooses B, it owns the support front line and must show the provider's filing status in its own UI.
- **Starting C without a tax-notice operation** (Rippling's dedicated team; Gusto's rule that the customer files after three failures).
- **Building a US engine from scratch as a suite.** Xero's NZ$16.2m write-off is the precedent.
- **Claiming CAO coverage without a maintenance process and a liability position** (the 2023 NL court case; Exact advertises about 140 maintained CAOs).

### 6.5 What this suggests per country and segment

- **NL, SMBs.** Start with A to Loket and Nmbrs: hours, leave and changes out; payslips and journals back. Add a GL import so WeldBooks can take entries from Employes or Exact. Treat C as a later decision. Employes shows that a scoped Dutch SMB engine can be built in about a year, but CAOs and pension fund declarations are the long tail.
- **NL, staffing agencies.** Export to staffing payroll systems such as Easyflex, and to Loket or Nmbrs, with hours tagged by placement and client. Equal-pay rules under ABU and NBBU make generic SMB payroll a poor fit for these customers. We did not verify which SMB engines handle them.
- **US, SMBs.** Choose B on Check or Gusto Embedded, as Zoho, Xero and HiBob did. WeldBooks US needs the payroll journal import regardless.
- **US, staffing.** We did not verify how well embedded providers handle multi-client staffing payroll, for example worksite-based state and local taxes, or many short assignments. Raise this with providers before choosing.

## 7. Could not verify

- Gusto's, Personio's and Rippling's own pricing and help pages blocked fetching. Gusto prices, Personio's "Germany only" wording and 2023 launch date, and Rippling's auto-approval behaviour come from search-indexed copies or third parties.
- The exact year BambooHR acquired TRAXPayroll. We only know the link existed by February 2019.
- HiBob's UK payroll launch date (a third-party mention says September 2024), and whether its NL offering goes beyond integrations.
- Gusto Embedded and Check wholesale prices, and their revenue-share terms.
- What Odoo's `l10n_nl_hr_payroll` actually computes, and whether it files loonaangifte.
- Exact Online Salaris prices per extra payslip (€7, or €3.50 when raising the bundle) come from a search-indexed Exact page. The live features page shows only the €92.50 bundle.
- Whether Employes, Exact or Loket handle the ABU/NBBU staffing CAOs (phase systems, equal pay to client staff).
- Any named complaint about missing CAO support in a Dutch payroll product.
- Payroll attach rates for any vendor.
- Deel's 2022 PayGroup acquisition; it is often cited, but we did not reach a primary source.
- Xero NZ payroll and the price of Xero's US embedded payroll.
- Whether SnelStart or Moneybird have announced their own payroll products. We found none, but that rests on an absence of results.
- The web-search budget for this session ran out partway through, so the later sections relied on direct page fetches. A follow-up session could close the gaps above.
