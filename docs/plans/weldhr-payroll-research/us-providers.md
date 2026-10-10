# US payroll for WeldHR: embedded providers and integration routes (approaches A and B)

Researched 8 October 2026. Sources are provider developer docs, provider websites, published terms and press releases. Where only a third party (review site, data aggregator, competitor) reports something, the text says so. The shared web-search budget ran out late in this pass, so a few items rest on a single source or on search-result excerpts; they are listed under "Could not verify". This file builds on section 8 of `docs/plans/weldbooks-us-research/federal.md` (Gusto General Ledger API, payroll journal entries).

Context from the product owner (received during the research): WeldSuite has no US legal entity and no plan for one, payroll should be a revenue line with margin, there is no concrete US customer demand yet, and the owner is willing to carry liability long term.

## Summary

- **In approach B the employer signs with the provider, not with WeldSuite.** Check's employer terms say the company buys payroll "through Your service provider", which pays fees to Check; Check is the IRS reporting agent and pays penalties caused by its own errors. Gusto's Embedded Payroll Service Agreement is likewise between Gusto and the employer, with the platform as a separate party. WeldSuite would be a reseller and the front end, not the payroll provider of record. The owner's willingness to carry liability does not change much under B; it only matters for approach C.
- **Margin is possible under B.** Check bills the partner from usage data and the partner prices its own customers (Usage API). Gusto describes Embedded as usage-based, with partner pricing setting partner gross margin. Everee offers "revenue share or wholesale". ADP Embedded offers a revenue share. No provider publishes wholesale prices; the one market benchmark found (third-party) is $35–70 per company plus $6–10 per employee per month retail, with the platform keeping roughly two thirds.
- **Check is the best first call for approach B.** It has the widest public API (workplaces per earnings line, contractors, garnishments, off-cycle, multi-EIN, filings, W-2/1099), drop-in components, webhooks, a sandbox, a payroll-journal report API with webhooks (September 2026), a startup track ("as little as 10 weeks"), and it says partners carry no credit or fraud losses. Its partner list includes non-US-headquartered platforms (Zoho uses Check for Zoho Payroll US).
- **Gusto Embedded is the strong second, with two catches.** It gates production behind commercial, security and implementation reviews and says it cannot support every use case. On faster payment speeds (2-day, next-day) an unrecovered failed employer debit becomes the partner's liability after 90 days. Gusto also sells payroll directly to the same SMBs.
- **Staffing-heavy use is a different market.** Daily pay, per-shift tax location, W-2 and 1099 in one run, and payroll credit while client invoices are open are what Zeal and Everee are built for. Both now also sell directly to staffing agencies (Zeal markets itself as a replacement for ADP, Paychex and TempWorks), so they are partners and competitors at once. Check covers multi-state staffing through workplaces per earnings line and next-day processing, and offers earned wage access through the Clair partnership.
- **No provider publishes a rule against a non-US platform partner, and none publishes a rule allowing it.** The real hurdles for a Dutch company with zero US customers are commercial reviews and track-record rules: Gusto App Integrations excludes "early-stage" products, ADP Marketplace looks for "a substantial number of shared clients", and Gusto Embedded has a commercial review. Check's startup program is the most open door found.
- **Approach A is narrower than it looks.** Unified APIs (Finch, Merge, Kombo) read payroll data well but do not write hours or earnings into US payroll runs; Finch writes only benefit deductions and contributions. Direct write APIs exist (Paylocity Pay Entry takes earnings, hours, deductions and cost centers; Gusto's Time Tracking API takes classified hours; Paychex and ADP have partner programs), but each needs a separate partner approval, often with a security review or SOC 2 report, and some want a track record.
- **Tax engines are not a shortcut.** Symmetry (owned by Gusto since 2021) and Vertex Payroll Tax compute withholding only. Registrations, deposits, filings, money movement, notices and amendments are what an embedded provider adds, and they are most of the work.

---

## 1. How embedded payroll is structured

An embedded provider gives a software platform an API and UI pieces to run payroll for the platform's customers. The provider computes gross-to-net, debits the employer's bank account, pays workers, deposits and files taxes, and produces W-2s and 1099s. The platform owns the user experience, first-line support (in most models) and pricing.

Two contract layers matter:

- **Check:** the employer accepts Check's Payroll User Service Terms (checkbox). "You are purchasing the Payroll Services through Your service provider", which "pays fees to Check"; Check "has no control over Your service provider's actions", and the service provider is a third-party beneficiary. The employer appoints Check as IRS Reporting Agent, which "does not relieve You of Your responsibility" for timely filings. Check's liability for tax failures is to remit taxes received and "reimburse You or pay directly to the appropriate taxing authority any penalties resulting from Check's error or omission". Money transmission is done by Check Payments LLC or licensed partners. Terms last updated 3 July 2023. (https://www.checkhq.com/employerterms ; Zoho's layered version: https://www.zoho.com/us/payroll/zchq-terms/)
- **Gusto Embedded:** the Embedded Payroll Service Agreement (last updated 3 September 2025) names the platform the "Platform Provider" and the employer the "Company"; Gusto is not responsible for the Platform Provider's errors, and the platform's own liability falls under separate Platform Provider Terms. The payroll admin must explicitly accept Gusto's terms through the API during onboarding. (https://flows.gusto.com/terms, seen through search excerpts because the page returns 403 to fetchers; https://docs.gusto.com/embedded-payroll/docs/onboard-a-company.md) A third-party reading of Gusto's terms says Gusto's liability is capped at fees paid in the prior 12 months and that penalties from bad employer data stay with the employer (https://conductatlas.com/platform/gusto/gusto-terms-of-service/limitation-of-liability-cap/, third party, and not confirmed to be the embedded agreement).

**Implication for WeldSuite:** under approach B, WeldSuite never becomes the reporting agent, never holds payroll funds and never signs Form 8655. That is why B is feasible without a US entity. It also means each employer has a direct contract with the provider, so switching providers later is a migration of every customer (new terms, new 8655, mid-year history import). Pick one provider per country and design the data model so the provider is a field, not an assumption (see section 8.3).

## 2. Embedded providers

### 2.1 Check (checkhq.com)

**Status.** Active and growing. Launched January 2021; last disclosed round is a $75M Series C led by Stripe in February 2022 (https://fintech.global/2022/02/17/check-lands-75m-led-by-stripe/, trade press; no 2025–2026 round found). Homepage claims 1M+ employees paid, 50,000+ businesses and $15B+ processed annually (https://www.checkhq.com/). A May 2025 release claimed 70+ partners and $4.1B processed in 2024 (https://www.silicon.co.uk/press-release/check-strengthens-market-leadership-as-demand-for-embedded-payroll-accelerates). Recent changelog: Checkmate AI agent (9 September 2026, free for partners through March), Report Run API with webhooks for payroll journal and summary (10 September 2026), Webhook Delivery API (13 August 2026) (https://www.checkhq.com/resources/changelog).

**API coverage** (https://docs.checkhq.com/ ; https://docs.checkhq.com/llms.txt):
- Company onboarding: Company Onboard component or API, requirements discovery, address and SSN validation, multi-EIN companies, external (prior) payrolls for mid-year migration.
- Employee and contractor onboarding: Employee Onboard bundles SSN, payment (direct deposit) and withholding (W-4) setup; Contractor Onboard.
- Pay schedules, payroll preview and approval, off-cycle payrolls, voids, paystubs, net pay splits.
- Earnings: each earning line carries a type or a company-defined earning code, hours, an amount or an earning rate, and a required `workplace`, so one paycheck can pay for work in several locations (https://docs.checkhq.com/docs/earnings.md). Piece-rate pay and reimbursements are documented.
- Benefits (pre-tax) and post-tax deductions, including garnishments (homepage lists garnishments; post-tax deduction object in the API reference).
- Contractor payments and contractor tax documents (1099).
- Tax: calculation for all 50 states and DC, multi-state withholding, reciprocity, courtesy withholding, withholding overrides; Filings API; employee tax statements (W-2) with a W-2 preview guide; tax deposits; tax packages.
- State registrations: Check does not register the employer. A missing state account number appears as an `applied_for_tax_id` blocker until the employer supplies it; Check needs power of attorney or third-party administrator access at each agency (https://docs.checkhq.com/docs/tax-filings.md).
- Time import: no separate timesheet object. The platform sends hours as earning lines.

**UI components.** Setup (rosters, bank connection, verification documents, signatory agreements), Company Onboard (terms, details, payment setup, tax setup, filing authorization, accounting integration), Run Payroll, Company Reports, Company Tax Documents, Filing Preview, Employee Onboard, Profile, Benefits, Post-Tax Deductions, Paystubs, Tax Documents, Contractor Onboard and Tax Documents (https://docs.checkhq.com/docs/check-components.md). Components are customizable; onboard links are generated through the API.

**Developer tooling.** Sandbox with simulation endpoints for processing, funding and disbursement; webhooks with configurable event types and redelivery; idempotency keys; a Sensitive Data API; a hosted MCP server and a CLI (https://docs.checkhq.com/).

**GL export.** Payroll journal with workplace breakdown, now via the Report Run API with a webhook when the file is ready (https://www.checkhq.com/resources/changelog), plus an accounting-integration component and a Layer accounting partnership guide (https://docs.checkhq.com/llms.txt). This removes the polling that `federal.md` section 8 notes for Gusto's GL API.

**Liability.** Check pays penalties caused by its own error or omission (employer terms above). Check says "Platforms built on us are not responsible for any credit or fraud losses, period" (https://www.checkhq.com/platform/payroll/credit-and-fraud-protection) and its startup page says "Zero responsibility for losses" (https://www.checkhq.com/solutions/startups). The full contract terms behind those claims were not seen.

**Money movement and risk.** Check debits the employer for the payroll's cash requirement and sends worker payments at the cancel deadline, "generally around 1pm ET the day before payday" (https://docs.checkhq.com/docs/payments.md). Wire funding is supported. Check Payments LLC is the licensed money transmitter (NMLS #2103307, https://www.checkhq.com/solutions/startups). Check's help center (login-gated; content seen only in search-result excerpts) describes standard processing (approval three or more business days before payday) versus accelerated (two or fewer), a strike system for failed fundings, and risk tiers that screen for litigation, tax liens and UCC liens (https://help.checkhq.com/payments--risk/4Msp39koQmy8fT3WaaFd3Q). Underwriting, fraud monitoring and watchlist screening are done by Check (https://www.checkhq.com/resources/blog/check-launches-credit-and-fraud-protection-embedded-setup-embedded-support).

**Support model.** "Embedded Setup" (Check staff prepare customers for their first payroll) and "Embedded Support" (Check payroll experts work under the platform's brand) are offered; whether they cost extra is not published (same blog post).

**Partner requirements and launch.** Startup page: "As little as 10 weeks" to launch; one case went from signature to live customers in 53 business days with one engineer (https://www.checkhq.com/solutions/startups). Self-paced playbooks and training on tax eligibility, filings and notices. No minimum volume or eligibility rules are published. Expedited go-lives are reviewed case by case during a "Preliminary Review" (Check changelog, March 2024, via search excerpt).

**Pricing.** Not published. The Usage API exposes billable events per partner: company, employee, contractor, company funding failure, payee failed payment, wire, one-day processing, delayed filing, amended return, refile, mailed return copy. Check bills the partner from this data, and the partner "annotate[s] it with the pricing data that lives in your application" to bill its customers. Negotiated aggregate fees and platform fees exist but are outside the Usage API (https://docs.checkhq.com/docs/usage.md).

**Known customers.** Case studies: Eddy, 7shifts, Miter, Trayd, Wave, Playground, Housecall Pro, Homebase, Warp, Dripos; logos include Zoho, Zenoti, BuddyPunch, Fresha and Keka (https://www.checkhq.com/). Zoho's US payroll uses Check for calculation, payouts, tax filing and garnishments (https://www.zoho.com/us/spend/kb/admin/payroll/check). Check states "We don't compete with our partners" (https://www.checkhq.com/resources/blog/all-in-one-for-everyone). No staffing-platform customer was confirmed.

**Ecosystem.** Workers' comp (Next, Coverdash), health (SimplyInsured, Benbase), 401(k) (Vestwell, Human Interest), earned wage access (Clair), accounting (Layer) (https://docs.checkhq.com/).

**Implication for WeldSuite:** Check's model matches the owner's goals: WeldSuite sets the end price, Check carries credit and fraud loss and tax-error penalties, and the employer's SSN and bank data can stay inside Check components. The workplace-per-earning-line model fits agencies whose employees work at several client sites.

### 2.2 Gusto Embedded

**Status.** Active (third-party sources disagree on the launch year, 2021 or 2023) and adding bank distribution: U.S. Bank launched U.S. Bank Payroll on Gusto in August 2025 (https://secure.businesswire.com/news/home/20250829586575/en/U.S.-Bank-Launches-New-Embedded-Payroll-Solution-for-Small-Businesses); Xero announced US payroll powered by Gusto in January 2025 (https://www.cpapracticeadvisor.com/2025/01/03/xero-partners-with-gusto-to-offer-integrated-payroll-solution/153874/). Other named partners in third-party reporting: Chase Payment Solutions, Lattice, Vagaro, SpotOn, Invoice2Go, Novo, and American Express (announced). Gusto also owns Symmetry, the tax engine many other payroll products license (section 5).

**API coverage** (https://docs.gusto.com/llms.txt):
- Company onboarding with terms acceptance, locations, bank (micro-deposits or Plaid), federal and state tax setup, industry, pay schedule, signatory identity check, Form 8655 (needs a wet signature when identity verification is skipped), then a Gusto risk review that can take up to 2 business days (https://docs.gusto.com/embedded-payroll/docs/onboard-a-company.md). Contractor-only companies and migration of existing companies are documented.
- Payroll: prepare, update `employee_compensations` (hourly lines with `hours` and `job_uuid` for Regular, Overtime, Double overtime; fixed compensations such as Bonus, Commission, Correction Payment, Cash and Paycheck Tips; paid time off hours), calculate, submit (https://docs.gusto.com/embedded-payroll/docs/complete-a-regular-payroll.md). Off-cycle, termination and selected payrolls exist as flows.
- Contractor payments by direct deposit or check, with expected debit date and submission blockers (https://docs.gusto.com/embedded-payroll/docs/process-contractor-payments.md).
- Child-support garnishments, deductions, benefits, time-off policies and requests, tax payments endpoints, information requests, recovery cases, wire-in requests (llms.txt).
- GL: request a General Ledger report per payroll, then poll for it; no webhook for readiness (https://docs.gusto.com/embedded-payroll/docs/retrieve-a-general-ledger-report.md).
- Webhooks and a demo (sandbox) environment are documented.

**UI components.** Gusto Flows are hosted pages (new tab or iframe with `postMessage` events) generated per company through the API; they expire after an hour of inactivity. Flow types cover onboarding, state and federal tax setup, run payroll, off-cycle, termination payroll, contractor payments, time off, I-9, deductions, reports, Xero and QuickBooks accounting sync, and partner products (health insurance, retirement, workers' comp, earned wage access enrollment) (https://docs.gusto.com/embedded-payroll/docs/flow-types.md ; https://docs.gusto.com/embedded-payroll/docs/gusto-flows-pre-built-ui.md). A React SDK exists but is "still in an early phase of development" (https://docs.gusto.com/embedded-payroll/docs/react-sdk.md).

**Money movement and risk.** Gusto debits the employer and pays workers and agencies. Speeds: 4-day (debit Monday, pay Friday only if the debit cleared), 2-day and next-day (Gusto pays before the debit clears). On 2-day, a failed debit goes to collections and "liability transfers to the Partner after 90 days" if unresolved. Partners set risk thresholds and a 24-hour `fast_payment_limit` (https://docs.gusto.com/embedded-payroll/docs/2-day-vs-4-day.md).

**Partner requirements.** "Commercial, security, and implementation reviews are required" before production; developers should get pre-approval before building heavily; Gusto "is not able to support all partner use cases at this time" (https://docs.gusto.com/embedded-payroll/docs/introduction).

**Pricing.** Not published. Gusto's own blog says Gusto Embedded is usage-based and partner pricing dictates partner gross margin; most vertical SaaS partners charge a monthly company fee plus a per-employee fee, and some give payroll away as a loss leader (https://embedded.gusto.com/blog/pricing-for-embedded-finance-saas-products-infographic/, seen via search excerpt; the site blocks fetchers). For reference, Gusto's direct price is $49/month + $6/person (Simple) and $80 + $12 (Plus) (https://gusto.com/product/pricing, via search excerpt).

**Implication for WeldSuite:** Gusto offers the most complete hosted UI (Flows), but WeldSuite would carry credit risk if it offers faster than 4-day pay, and the employer becomes a Gusto customer of a company that also sells payroll directly. The commercial review is the gate a company with zero US customers is most likely to fail.

### 2.3 Zeal

**Status.** Active, smaller. Third-party profiles report a $13M Series A (2021) and a $15M Series B (October 2024) (https://yespress.io/zeal.md, third party). Banking through Bangor Savings Bank (https://www.zeal.com/).

**Coverage.** Payroll API with partner dashboard, companies, work locations, W-2 employees and 1099 contractors, employee checks, contractor payments, webhooks, white-label onboarding and employer/worker dashboards (https://docs.zeal.com/). Zeal says it built its own tax engine covering "11,000+ U.S. tax jurisdictions", runs several shift arrangements in one payroll run, and supports daily pay, 24/7/365 payouts, Instant Pay (push-to-card), same-day ACH, paycards and wallets (https://www.zeal.com/pay ; https://www.zeal.com/llms.txt). Onboarding includes remote I-9 with E-Verify. "Zeal Bill" (turn worker pay into receivables and client invoices, plus working capital) is marked "Coming Soon" (https://www.zeal.com/bill).

**Customers.** Wonolo, Traba, Qwick, Veryable, WorkGenius, Lawtrades, NurseIO, ACE FMS, Backlit, Band of Hands, Jyve, Humla Health, AcrobatStaff (https://www.zeal.com/). Wonolo sends time and rates in real time, uses payroll preview to get net pay, and pays 80% of net the same day (https://www.zeal.com/webinars/how-wonolo-facilitates-daily-pay-for-w-2-workers-with-zeal).

**Liability, pricing, partner terms.** Not published. A third-party directory says Zeal acts as reporting agent and takes on payroll liability, and that it offers a referral model with no cost to the platform (https://openbankingtracker.com/embedded-finance/zeal, third party).

**Positioning change.** Zeal's site now pitches staffing companies directly ("Why staffing companies choose Zeal over all-in-one platforms", replaces "ADP, Paychex, and TempWorks", Bullhorn integration, branded worker app) (https://www.zeal.com/llms.txt).

**Implication for WeldSuite:** Zeal is the clearest fit for gig-style daily pay, but it now sells the onboard-pay-bill back office to the same staffing agencies WeldHR targets. Treat it as a fallback for staffing if Check cannot cover daily pay, and expect channel conflict.

### 2.4 Everee

**Status.** Active; named to Fast Company's 2026 Most Innovative Companies list (HR category) (https://www.goskagit.com/everee-named-to-fast-companys-2026-list-of-the-worlds-most-innovative-companies/article_4d9d7d1e-8ab3-510e-b352-3ae00cae29cc.html, press-release reprint).

**Coverage.** Integration API with workers (W-2 and 1099), shifts on timesheets and bulk classified hours per pay period, payable items (bonuses, commissions, reimbursements) with ASAP payout, pay history, early pay, W-4/W-9 data, work locations, multiple EINs, real-time payroll enrollment, webhooks; embedded onboarding and pay-card signup via magic links in a webview or iframe (https://developer.everee.com). For staffing: pay after verified shift end by same-day ACH or instant pay card; tax rules applied per shift location; pay rates, comp codes and locations per shift or assignment; integrations with Bullhorn, ActivateStaff, LaborEdge, NextCrew, Tracker and Deputy; "Flex Credit" fronts payroll while client invoices are open, repaid from collections (https://www.everee.com/staffing/ ; https://www.tracker-rms.com/integrations/everee/).

**Pricing.** No figures published. Models: per payment processed (staffing), per active employee (HR & payroll), and for technology partners "Flexible revenue share or wholesale pricing" (https://www.everee.com/pricing). A review site lists $10 per employee per month or $0.50 per transaction (third party).

**Implication for WeldSuite:** Everee has the best published fit for agency payroll (per-shift tax location, per-assignment rates, payroll credit) and an explicit wholesale option. Like Zeal, it also sells directly to agencies.

### 2.5 Salsa

**Status.** Active. $20M Series A on 22 April 2025 led by Altos Ventures, $30M raised in total; reported 10x growth in 2024; US and Canada (https://www.pymnts.com/payroll/2025/salsa-raises-20m-to-expand-embedded-payroll-services-across-us-and-canada/). No 2026 round found.

**Coverage.** Two build paths: Salsa Express (prebuilt embeddable elements for employer onboarding, tax setup, bank accounts, pay groups, run payroll, worker self-onboarding) and Salsa Advanced (GraphQL API) (https://www.salsa.dev/ ; https://docs.salsa.dev/). Guides cover webhooks, early wage access, overtime, premium pay, wage parity (New York home care), accounting integration, usage calculation for billing customers, and "Providing Employer Risk Metrics". Salsa debits gross wages plus employer taxes plus reimbursements and remits payroll taxes (https://docs.salsa.dev/docs/money-movement).

**Customers.** HoneyBook, GlossGenius, Mangomint, Jane, DaySmart, HHAeXchange, Easyteam, Innergy, Band of Hands and others (https://www.salsa.dev/). Focus is vertical SaaS (beauty, health, home care), not staffing.

**Liability and pricing.** Not published. A third-party FinOps profile says Salsa charges a platform base fee plus a per-active-paid-worker monthly fee, with money movement as pass-through (https://apis.io/finops/salsa/salsa-finops/, third party). The "Employer Risk Metrics" guide suggests partners feed underwriting, but loss allocation is unknown.

### 2.6 Rollfi (Priority Technology)

Priority Technology Holdings (Nasdaq: PRTH) announced the acquisition of Rollfi on 24 January 2025 (https://prioritycommerce.com/priority-acquires-rollfi-payroll-and-benefits-software, seen via search; the investor page blocks fetchers). Rollfi offers three tiers: white label ("ZERO developer resources"), embedded, and a full API, for W-2 and 1099 payroll in 50 states, plus benefits advisors; money moves over Priority's banking platform with "20+ banks and nationwide Money Transmitter Licenses" (https://www.rollfi.xyz/). It names staffing companies as a target. No public API detail, pricing or customer list was found.

**Implication for WeldSuite:** the white-label tier is the only option seen that needs no engineering, which could serve as a demand test. It is owned by a payments company that will want to cross-sell its banking stack.

### 2.7 Incumbents' embedded programs: ADP and Paycor

- **ADP Embedded Payroll** launched for small-business software in late 2025, with Fiserv's Clover (RUN inside Clover) and Fieldclock as named partners. It offers APIs or prebuilt UIs, ADP service teams and a "Revenue share, made for integrated partners" (https://www.adp.com/what-we-offer/products/adp-embedded-payroll.aspx ; https://businesstech.co.za/news/industry-news/845745/adp-embedded-payroll-gives-partners-a-competitive-edge-with-integrated-hcm-solution/, sponsored content). The sign-up form asks for the number of US and non-US clients. A revenue share suggests ADP bills the employer, which means less pricing control for the platform (not confirmed).
- **Paycor "Embedded Partners"** offers Paycor HR and payroll inside partner products; Paychex agreed to acquire Paycor (https://www.paycor.com/resource-center/guides-white-papers/embedded-payroll/). Partners and terms are not published.

### 2.8 Not relevant for the US

Nmbr (Toronto) is Canada-only; its first production customer was Collage in February 2026 (https://www.fintech.ca/2026/02/17/nmbr-enables-embedded-payroll-inside-canadian-hr-platform/). Not to be confused with Nmbrs (Visma), which matters for the Netherlands file.

## 3. Can a Dutch company with no US entity and no US customers become a partner?

No provider publishes partner-eligibility rules on headquarters country, US entity, EIN or US bank account. What the sources show:

| Provider | Evidence about non-US partners | Stated gate | Who sets the end-customer price |
|---|---|---|---|
| Check | Zoho (India HQ) runs Zoho Payroll US on Check; Wave (Canada HQ) is a case study; Fresha (UK) and Keka (India) logos on the homepage (not confirmed as US payroll users). All likely have US subsidiaries (not verified). | Startup track; "Preliminary Review"; no published minimums | Partner (Usage API, partner applies own prices) |
| Gusto Embedded | Xero (NZ HQ) is a partner, but has US operations | Commercial, security and implementation reviews; "not able to support all partner use cases" | Partner (Gusto blog: partner pricing sets margin) |
| ADP Embedded | Form asks for US and non-US client counts | ADP Marketplace wants "a substantial number of shared clients" (https://partners.adp.com/) | Revenue share; likely ADP bills (unconfirmed) |
| Everee | None found | Not published | "Revenue share or wholesale" |
| Salsa | Serves Canadian platforms (Jane) | Not published | Partner, per third-party profile |
| Zeal, Rollfi | None found | Not published | Not published |

Requirements that do not depend on the provider and that WeldSuite would need anyway (inferred, not from provider docs): US-hours customer support in English, a security posture that passes vendor review (Gusto's App Integrations review asks for a SOC 2 Type 2 report and is run with VISO TRUST, per https://help.merge.dev/en/articles/10354314-gusto-how-do-i-set-up-my-integration, third party), USD billing of US customers (WeldSuite's existing Stripe billing should do this), and a Form W-8BEN-E for any US payer of revenue share.

**Implication for WeldSuite:** the blocker is more likely "no US customers" than "no US entity". Approach the providers with a concrete pipeline (named agencies or SMBs that would switch), or expect to be parked. Ask each provider in writing: (1) do you contract with a non-US entity, (2) do you need a US bank account or EIN to pay your invoices, (3) minimum annual fee or launch commitment, (4) loss allocation at each payment speed, (5) who handles tier-1 support and at what cost.

## 4. Staffing and BPO fit

What a staffing agency needs from US payroll, and who covers it:

- **Weekly pay with many short assignments.** All providers support weekly schedules. Assignment-level rates: Check (earning codes and rates per line), Everee (rates per shift or assignment), Zeal (several shift arrangements in one run).
- **Multi-state worksites in one pay period.** Check requires a workplace per earning line and computes SUI from the primary workplace (https://docs.checkhq.com/docs/workplaces.md); Everee taxes each shift where it was worked; Zeal handles multi-location rules. For Gusto, earnings carry a `job_uuid` and employees have work addresses, but per-line work location was not confirmed.
- **Daily pay or earned wage access.** Native in Zeal and Everee (same-day ACH, push-to-card, paycards). Check bills a "one-day payroll processing period" and partners with Clair for EWA. Gusto has EWA enrollment flows.
- **W-2 and 1099 in one system.** All six main providers.
- **Funding gap.** Agencies pay weekly but collect client invoices on net terms. Everee offers Flex Credit; Zeal Bill promises working capital (coming soon). Check and Gusto offer wire funding but no credit.
- **Pay and bill from the same hours.** No embedded provider generates client invoices today except Zeal's announced Bill. In WeldSuite, WeldBooks would invoice the client from the same approved hours that feed payroll.
- **Who powers staffing platforms.** Zeal: Wonolo, Traba, Qwick, Veryable, WorkGenius, NurseIO. Everee: Tracker and NextCrew integrations, Bullhorn listed. Check and Gusto: no staffing customer confirmed in this pass. Staffing back-office suites (TempWorks, Avionté) run their own payroll, and Zeal positions itself against them.
- **BPO agencies.** Workers outside the US need local payroll or an EOR, not US payroll. US payroll only matters for BPO firms with US-based staff.

**Implication for WeldSuite:** the WeldHR model (employee → client assignment with allocation %) maps onto Check's model as: client site = workplace, assignment role = earning code, hours per assignment = earning lines. The same approved-hours record must drive the pay line (pay rate) and the WeldBooks invoice line (bill rate). Store both rates on the assignment.

## 5. Tax engines are not embedded payroll

- **Symmetry Tax Engine (STE)**: withholding calculation for US federal, state and local taxes and Canada, as an on-premise SDK or hosted API; Gusto built its product on STE and acquired Symmetry in July 2021, and Symmetry continues to serve clients under its own brand (https://www.symmetry.com/payroll-tax-insights/symmetry-software-joining-gusto ; https://paycheckcity.com/about-symmetry).
- **Vertex Payroll Tax**: cloud gross-to-net payroll tax calculation for the US and Canada, sold to HCM and staffing systems via REST, with a Docker on-premise option and SOC 2 Type 2 (https://www.vertexinc.com/resources/resource-library/introducing-vertex-payroll-tax). Vertex is still public and reported Q1 2026 results (https://finance.yahoo.com/markets/stocks/articles/vertex-inc-verx-q1-2026-210025915.html, third party).

What a tax engine leaves to the platform: state withholding and SUI account registration, IRS reporting-agent status (Form 8655) and state equivalents, collecting funds from employers and paying workers (money-transmitter licences or a bank sponsor), deposit schedules, quarterly and annual filings (941, 940, state wage reports, W-2/W-3 to SSA, 1099), agency notices, amendments, garnishment remittance, new-hire reporting, and credit risk on employer debits. Check's usage categories (delayed filing, amended return, refile, mailed return copy, funding failures) show the operational load that sits outside calculation.

**Implication for WeldSuite:** a tax engine only makes sense for approach C, and approach C in the US also needs licensed money movement that a company without a US entity cannot easily get. A tax engine does not turn A into B.

## 6. Approach A: pushing data into the customer's existing payroll

### 6.1 Direct provider APIs

- **Gusto (direct customers).** The Time Tracking API takes one shift per employee and job, with hours split into regular, overtime and double overtime (`POST /v1/companies/{company_uuid}/time_tracking/time_sheets`); the employer then applies the hours in Gusto with a "Sync hours" button, so the API does not finalize payroll (https://docs.gusto.com/app-integrations/docs/syncing-time-tracking-data.md). Partner apps also sync PTO requests, earnings and general ledger (https://docs.gusto.com/app-integrations/docs/build-an-application). Gates: Production Pre-Approval, Security Review and QA before production keys; approval "is not guaranteed"; the program excludes "early-stage" products "still establishing a track record with small businesses" (https://docs.gusto.com/app-integrations/docs/introduction). Finch reports the security review takes several weeks with no fast track (https://developer.tryfinch.com/implementation-guide/Integration-Preparation/Security-Reviews).
- **Paylocity.** The Pay Entry API creates a payroll batch for a pay period with earning (E), deduction (D) or accrual (A) lines per employee: code, hours, amount or temporary rate, three cost centers, job code, shift, workers' comp code and check sequence (https://developer.paylocity.com/integrations/reference/payentryv2_postpayentryimport.md). A Punch Import API covers raw time. This is the richest write route found and fits staffing (cost center = client). Partner terms not published.
- **Paychex Flex.** Partner onboarding: questionnaire, corporate partnerships review, sandbox build, demo to Paychex, then production keys; each client approves the app in Paychex Flex using its 8-digit display ID (https://developer.paychex.com/partner). Whether third parties can add earnings or hours to unprocessed checks could not be confirmed from the docs (rendering failed).
- **ADP RUN and Workforce Now.** Access runs through the ADP Marketplace partner program, which looks for "a substantial number of shared clients", "differentiated HCM solutions" and digital purchasing (https://partners.adp.com/). Pay-data-input API details could not be read.
- **Rippling.** The v2 API documents "Create a Time Entry" (write) and a "Manage Payroll" guide for operating payroll; App Shop apps must meet partner requirements (https://developer.rippling.com/llms.txt). Write scope for earnings was not confirmed. Unified.to notes Rippling access is partner-gated (https://docs.unified.to/llms.txt).
- **QuickBooks Payroll.** Intuit's developer docs did not render. QuickBooks Online's accounting API has a TimeActivity (timesheet) entity that QuickBooks Payroll can use for hourly pay; whether third parties can add bonuses or deductions to a pay run was not confirmed.
- **Paycom.** No public developer documentation found; Unified.to lists a credential-based Paycom connector (https://docs.unified.to/llms.txt).

### 6.2 Unified APIs

- **Finch.** Reads organization and payroll data (pay statements, payments, pay groups) across 250+ providers on paid plans. The only write product is Deductions: company-level benefit setup and individual enrollment for retirement, medical and other benefits (https://developer.tryfinch.com/implementation-guide/API-Calls/Write-Data). Automated write covers about 5 providers; "assisted" integrations cover 20+ by having the employer add Finch as a third-party administrator, with changes written within 2 business days (https://developer.tryfinch.com/integrations/integration-types). Paychex Flex, Paycom and TriNet do not allow automatic benefit creation. Pricing: Starter $65 per connection per month (24 providers, read only, up to 15 connections); Pro and Premier (all providers, deductions write) by quote (https://www.tryfinch.com/pricing). No hours or earnings write.
- **Kombo** (Berlin): HRIS writes are limited to creating employees, absences, documents and skills, plus DATEV file writes for German payroll; pay runs and payslips are read-only (https://docs.kombo.dev/_llms/developer-documentation/hris.md).
- **Merge**: documents a TimesheetEntry model, but write support for payroll systems could not be confirmed (https://docs.merge.dev/hris/timesheet-entries/).
- **Unified.to**: HRIS coverage includes ADP Workforce Now, Paycom, Rippling and Gusto; write support for payroll objects not confirmed.

**Implication for WeldSuite:** a unified API is useful for reading pay results back (to post payroll journals into WeldBooks and show net pay in WeldHR) and for benefit deductions. It does not deliver approach A's core job, which is putting hours, bonuses and leave into the next pay run. That needs one integration per payroll product, each with its own partner approval.

### 6.3 File exports

Every major SMB payroll product accepts some form of hours or earnings import file, which needs no partner approval. Formats were not verified per provider in this pass.

## 7. Comparison

| Provider | Coverage | UI components | Contractors | Staffing fit | Tax-error liability | Money movement and credit risk | Pricing model | Partner effort |
|---|---|---|---|---|---|---|---|---|
| Check | Full: onboarding, W-4, direct deposit, schedules, earnings with codes and workplaces, benefits, garnishments, off-cycle, multi-EIN, filings, W-2/1099, journal reports | Yes, broad component library | Yes, 1099 | Good: workplace per earning line, next-day processing, EWA via Clair; no confirmed staffing customer | Check pays penalties from its errors; reporting agent | Check Payments LLC; Check underwrites; partner bears no credit or fraud loss (Check's claim) | Wholesale usage fees plus negotiated platform fees; partner sets price | "As little as 10 weeks"; startup track |
| Gusto Embedded | Full; GL report by polling | Flows (hosted, iframe), React SDK early | Yes, incl. contractor-only | Medium: weekly pay, jobs, EWA flows; per-line location unconfirmed | Employer contracts with Gusto; cap and data-error terms per third-party reading | Gusto moves money; partner liable after 90 days for unrecovered fast-payment debits | Usage-based wholesale; partner sets price | Commercial, security, implementation reviews; selective |
| Zeal | Full; own tax engine; I-9/E-Verify | Yes, white-label onboarding and dashboards, branded app | Yes, same system | Strong: daily pay, paycards, gig and staffing customers | Reporting agent and liability (third-party claim) | Bangor Savings Bank; instant and same-day pay | Not published; referral and revenue-share models reported | Unknown; sells direct to agencies too |
| Everee | Full; timesheets, payables | Yes, webview or iframe onboarding, pay card | Yes | Strongest published: per-shift tax location, per-assignment rates, Flex Credit, Bullhorn and staffing ATS links | Not published | Same-day ACH, pay cards; payroll credit offered | Revenue share or wholesale | Unknown; sells direct to agencies too |
| Salsa | Full; GraphQL | Yes, Salsa Express | Yes | Low to medium: home care, wage parity, early wage access | Not published | Salsa moves money; risk allocation unknown | Base fee plus per active worker (third party) | "Weeks"; hands-on |
| Rollfi (Priority) | W-2 and 1099, 50 states, benefits | White label, embedded, API | Yes | Targets staffing; no detail | Not published | Priority banking, MTLs | Not published | White label needs no engineering |
| ADP Embedded | Payroll, payments, tax | APIs or prebuilt UIs | Not stated | Not stated | Not published | ADP | Revenue share | Unknown; ADP wants shared clients for marketplace |

## 8. Recommendation

### 8.1 Approach B (embedded): who to talk to first

1. **Check first.** It best fits the owner's three conditions: WeldSuite sets the end price and keeps the margin, Check carries credit, fraud and its own tax-error risk, and the API plus components cover both SMBs and multi-site agencies without a second provider. It also sells only through platforms, so it does not compete for the customer. Ask Check for its partner terms for a non-US entity, platform fee and minimums, per-employee and per-company wholesale prices, whether Embedded Support is extra, and how next-day processing and Clair EWA are priced.
2. **Gusto Embedded second,** mainly as a price and terms comparison, and as the option if Check declines. Accept 4-day processing only, unless WeldSuite wants to carry 90-day credit exposure.
3. **Everee only if staffing agencies become the main US segment.** It has the best published agency features (per-shift taxes, daily pay, payroll credit) and a wholesale option. Running two embedded providers (Check for SMBs, Everee for agencies) doubles integration and support cost, so defer this until agency demand is real. Zeal is the alternative, with more channel conflict.
4. **Do not build approach C for the US.** Money transmission and 50-state filing operations are a business of their own (section 5), and a company without a US entity cannot easily get licensed money movement.

Because there is no US demand yet, the first step is a discovery call and a written answer to the questions in section 3, not a build. Check's 10-week claim means the build can wait until a first US customer is signed.

### 8.2 Approach A (prep and export): which integrations

1. **CSV exports first** in the formats of Gusto, QuickBooks Payroll, ADP RUN, Paychex Flex and Paylocity. No partner approval, no security review, and it serves the first US customers whatever they run.
2. **Then APIs where they exist and the gate is passable:** Paylocity Pay Entry (earnings, hours, deductions and cost centers in one batch, the best fit for agencies) and Gusto's Time Tracking API (hours only; needs pre-approval, security review and a track record). ADP Marketplace and Rippling once there are shared clients.
3. **Finch only for read-back,** to import pay statements for WeldBooks journals and WeldHR pay history, and for benefit deductions. It cannot push hours.

### 8.3 Data-model notes for WeldHR

- Earnings lines need a type or code, hours, rate or amount, a work location and an assignment or client reference. That one record should feed the provider pay line and the WeldBooks invoice line (pay rate and bill rate stored on the assignment).
- Work locations should be first-class records (client sites), mapped to provider workplace IDs.
- Keep provider references (`provider`, `external_company_id`, `external_employee_id`, `external_payroll_id`) on companies, employees and pay runs, and mirror pay-run status from webhooks.
- For US employees under approach B, collect SSN, W-4 and bank details through provider components, not WeldHR's encrypted blob. WeldSuite then stores no US SSNs, which also avoids keeping US tax identifiers in an EU database.
- Import the provider's payroll journal (Check Report Run API, Gusto GL report) into WeldBooks per pay run, as `federal.md` section 8 describes.

## Could not verify

- Whether any provider contracts with a non-US platform that has no US subsidiary, and whether a US bank account or EIN is needed to pay provider invoices. No provider publishes this; Zoho, Wave and Xero all have US operations.
- Wholesale prices, platform fees and minimum commitments for Check, Gusto Embedded, Zeal, Everee, Salsa, Rollfi and ADP. The $35–70 base plus $6–10 per employee benchmark and the two-thirds platform share come from an aggregator (https://www.banq.ai/embedded-finance/category/payroll, third party).
- Check's help-center details (processing periods, failed-funding strikes, risk tiers): the help center requires a login and was seen only through search-result excerpts.
- The full Gusto Embedded Payroll Service Agreement (flows.gusto.com/terms returns 403); the liability cap comes from a third-party summary that may describe Gusto's direct terms.
- Whether Gusto Embedded supports a different work location per earning line, and how Gusto registers or prompts state tax accounts for multi-state staffing.
- Liability and loss allocation for Zeal, Everee, Salsa and Rollfi; the Zeal reporting-agent claim is third-party.
- Whether Fresha and Keka use Check for US payroll (logos only).
- No staffing-platform customer of Check or Gusto was confirmed.
- Paychex Flex, ADP (RUN, Workforce Now), Rippling payroll-write and QuickBooks Payroll API details: their developer sites did not render for fetching. Paycom has no public API docs.
- Merge and Unified.to write support for US payroll objects.
- Rollfi's API scope and customers; whether ADP Embedded bills the employer directly.
- Whether Check's Embedded Setup and Embedded Support are included or paid.
- State tax account registration: Check needs the employer to supply account numbers; whether any provider registers on the employer's behalf in all states was not checked.
- Funding status after 2022 for Check and after 2024 for Zeal: no newer rounds found, but the search budget ran out before a final check of 2026 news.
