# Dutch payroll providers and integration routes (approaches A and B)

Researched 8 October 2026. Sources are provider developer docs, pricing pages, help centers and dated trade press. Where only a third party (a unified-API vendor, a consultancy, a competitor) reports something, the text says so. The shared web-search budget ran out late in the research, so the global-provider section (3.3) rests on direct fetches of provider pages and is thinner than the Dutch sections. Anything not confirmed is listed at the end.

Context from the product owner: payroll is meant as a revenue line (per employee, margin matters), there is no concrete customer demand yet, WeldSuite is a Dutch/EU company, and the owner is willing to own liability long term, so a provider may be a stepping stone to an own engine (C).

## Summary

- **The SMB market is concentrated in three channels: Loket.nl, Nmbrs and the accounting suites (Exact, AFAS), mostly reached through accountancy firms.** Loket belongs to the Van Spaendonck group, not Visma. Nmbrs belongs to Visma, and since 1 September 2026 it is also the umbrella brand for Visma's Dutch SMB suite (Yuki, WeFact, Visionplanner), so it now competes with WeldSuite as an all-in-one product, not only as a payroll engine.
- **Loket has the best public API for approach A.** It is REST with OAuth2 authorization code, has an acceptance environment, and has a documented "Payroll Period Data" (variabele gegevens) write resource. It also exposes payroll run results, payslips, year-end statements and journal runs (loonjournaalpost) for reading. Personio picked Loket for its native Dutch payroll integration in 2025.
- **Nmbrs has a new REST API (SOAP retires in 2027) that can write variable hours, variable wage components, salaries, contracts, bank accounts and leave requests.** It needs a registered partner integration plus a subscription key per API product. No webhooks were found.
- **Exact Online and AFAS are weaker write targets.** Exact's payroll API is read-only except `VariableMutations`, and employees cannot be created over the API. AFAS is fully writable (`KnEmployee`, `HrCompMut` loonmutaties), but each customer has to create a token and the connectors, and partner integrations are certified.
- **Approach B has no clean Dutch option today.** No Dutch provider publishes a white-label or embedded payroll program. Employes comes closest technically: a simple REST API that can create companies, employees, employments and payrun data, while Employes calculates, files loonaangifte and pension, and pays out. But it uses personal bearer tokens, has no sandbox or partner program, and is now owned by Shine. Remote is the only global player with a documented white-label partnership that covers payroll for the customer's own entity, lists the Netherlands, and lets the partner set per-company pricing over the API. It is a white-glove commercial deal and built for international teams, not Dutch SMB payroll.
- **Wholesale economics exist, but only through accountant licences.** Nmbrs sells per-payslip packages to accountants (€2.32 per payslip at 60/month, €1.16 at 10,000/month) against a business list price of about €7 per employee at 10 employees. Employes' accountancy plan is €5 per payslip plus €25 per month with up to 20% off, against €7 to €9 plus a base fee retail. Using either licence means WeldSuite runs payroll as a bureau, with staff, not as software.
- **Unified APIs do not remove the partner work.** StackOne's Loket and Nmbrs connectors expose the needed write actions, including payroll period data and variable wage components. Kombo, Apideck and Merge cover NL systems mostly for reads and employee creation. Every route still needs WeldSuite to obtain Loket client credentials or an Nmbrs partner registration.
- **There is no common Dutch import format.** Each system has its own: Loket takes a semicolon CSV of `aanslnr;persnr;ploeg;<component numbers>`, Nmbrs an Excel template, AFAS an import parameter per wage component. SETU covers staffing timecards, not payroll input. A generic export needs a per-provider component mapping table.
- **Recommendation:** do approach A first with Loket (API), then Nmbrs (API), plus a CSV/Excel export with presets for Loket, Nmbrs, AFAS and Exact as the fallback. Treat B as a commercial question to put to Employes and Remote before building anything. Whichever route is chosen, store structured payroll results from day one, because that history is what a later move to an own engine (C) needs.

---

## 1. The landscape

### 1.1 Who Dutch SMBs and their accountants use

| Product | Owner | Main channel and segment | Size signals |
|---|---|---|---|
| Loket.nl | Van Spaendonck group (footer "Loket is onderdeel van Van Spaendonck", https://www.loket.nl/) | Accountancy firms and SMB employers | "over 130,000" entrepreneurs in 2020 (https://www.emerce.nl/wire/arnold-barendrecht-nieuwe-directeur-loketnl-spaendonck); about 250 accountancy firms used it daily in 2019 (third-party summary of a Loket announcement on salarisvanmorgen.nl) |
| Nmbrs | Visma since 12 May 2020 (https://www.mynewsdesk.com/visma/pressreleases/hr-and-payroll-supplier-nmbrs-becomes-part-of-visma-3121874) | Accountancy firms and SMB/mid-market employers | In 2020: about 2,000 customers, 920,000 payments a month, 160,000 companies (same press release) |
| Nmbrs Business Software (Nmbrs + Yuki + WeFact + Visionplanner) | Visma | All-in-one SMB suite since 1 September 2026, one login | 500,000+ companies across the four products, 450 staff, 350+ integrations, goal "market leader in business software for Dutch SMB by 2030" (https://www.accountant.nl/nieuws/2026/8/wefact-yuki-nmbrs-en-visionplanner-gaan-samen-verder-als-nmbrs/) |
| Exact Online salaris / loonadministratie | Exact | Exact Online accounting customers and their accountants | No payroll-specific figures found |
| AFAS Profit (Loon/HRM) | AFAS Software | Mid-market and larger employers, implementation partners | AFAS ranks first in MT1000 2026 finance and ERP, Exact second (https://mtsprout.nl/ranking/mt1000-2026/categorie/finance-en-erp-software) |
| Visma Raet Youforce | Visma (Raet joined in May 2018, third-party: https://www.consultancy.eu/news/2112/norwegian-software-firm-visma-steps-up-ma-in-the-netherlands) | Large organisations, public sector, healthcare | Not found |
| Employes | Shine since July 2025 (https://www.employes.nl/over-ons) | Self-service SMBs (2 to 100+ staff) and small accountancy firms | "8,000+ companies" (https://www.employes.nl/), 5,000 customers in October 2024 (over-ons page) |
| ADP Nederland | ADP | International Managed Payroll Services for foreign companies with 1 to 30 Dutch staff (https://nl.adp.com/onze-diensten/salarisadministratie/international-managed-payroll-services.aspx) | Not found |
| Easyflex, Mysolution, Tigris | Various | Staffing agencies (uitzendbureaus); payroll is built into the back office | See 2.7 |

- **Market share.** No representative figures exist in public. A 2020 Salaris Vanmorgen survey of 400 respondents found Nmbrs 23.6%, Loket.nl 22.4% and AFAS 20.9%, and the publisher warns this is not the real market split (https://www.salarisvanmorgen.nl/2020/09/11/sv-enquete-top-3-salarisoftware-waardering-koppelingen-aanbevelen/). The GBNED guide 2025/2026 covers 31 payroll packages and expects the number to keep shrinking through acquisitions (https://www.accountant.nl/nieuws/2025/10/nieuwe-gids-salaris--en-hr-software/).
- **Accountants are the distribution channel.** Both Loket and Nmbrs have accountant products (Loket "Slimmer adviseren", Nmbrs accountant pricing per payslip, section 2.2). Many SMBs never touch the payroll tool themselves; their accountant enters the mutations.
- SnelStart's payroll offering could not be confirmed (its payroll page returned 404).

**Implication for WeldSuite:** approach A has to fit an accountant workflow. The customer's accountant usually owns the Loket or Nmbrs administration, so the integration must work with an accountant's credentials and an employer selection, not only with the employer's own login. The Nmbrs rebrand also matters: Nmbrs now sells invoicing, accounting and payroll as one suite to the same SMBs WeldSuite targets, so its partner terms could tighten. Loket has no accounting product of its own and is the safer long-term partner.

## 2. Serious candidates in detail

### 2.1 Loket.nl

- **API.** REST, JSON, OpenAPI 3.1 spec, split into microservices (Employment, Payslip, Leave, Journal, PayrollComponent, PayrollConfiguration, PayrollTaxReturn, AutomaticPayroll, Absence and more) (https://developer.loket.nl/). Acceptance environment at `api.loket-acc.nl/v2` with test data, production at `api.loket.nl/v2` "exclusively by approved applications" (https://developer.loket.nl/, search summary of the landing text).
- **Auth.** OAuth2 authorization code, plus an SSO flow with Loket as identity provider. Before calling, an app should check the user's rights per employer with `GetAuthorizationsByEmployerId` (https://developer.loket.nl/guidelines.md). Loket issues the client credentials and test users; production users authorize themselves. BSN is authorized separately "only with reasonable cause" (same).
- **Partner access.** Apply for a client and user through the form on loket.nl; questions to api@loket.nl; the partner builds and Loket gives technical support (guidelines.md). Third party: production access is scoped to the list of operations the integration declared (https://developers.apideck.com/apis/hris/loket-nl/overview). No published partner fee.
- **Write.** The key resource is **Payroll Period Data ("Variabele Gegevens")**: actuals per employment per payroll period, such as hours worked, travel expenses or meal allowances. Sequence: `GET Employers` → `GET Employments` → optional `GET WorkingHours`/`GET Wages` → fetch metadata and defaults → `PATCH Payroll Period Data` → `GET` to verify. The payroll administration's configuration decides which components are allowed. Periods are 1 month, 4 weeks or 1 week (guidelines.md). Employee updates use normal PUT/POST/DELETE. New employees should be created as a **jobApplicant / conceptEmployee** and completed by the accountant in the Loket GUI; full creation through the API is possible but "not recommended" because creating an employee also creates employment, working hours, wages, fiscal properties, social security, Zvw, SEPA payment information and more (guidelines.md).
- **Read.** Employer, employee and employment data, `GET Absence`, `GET Leave`, `GET WorkingHours`, `GET Wages`, `GET Payslips`, year-end statements, `GET Payroll Runs` → `GET Payroll Run Results` ("the basis for payslips, tax returns and pension returns"), `GET Journal Runs` → `GET Journal Run Results` with general ledger account, cost center and cost unit (requires the journal module) (guidelines.md). StackOne's connector lists write actions for leave, absences, wages and working hours too (https://docs.stackone.com/connectors/loket), so the API is broader than the guidelines page shows.
- **Webhooks.** None documented; Loket asks partners to follow the API changelog (guidelines.md). Apideck offers "virtual" (polling) webhooks for employee created/updated.
- **Pricing to the end customer.** Not published; the site only offers a demo and brochure (https://www.loket.nl/).
- **Reseller economics.** Accountancy firms resell Loket-based payroll at their own prices, but Loket's wholesale terms are not public. No referral or revenue-share program was found.
- **Migration away.** Good: payroll run results, payslips, year-end statements and journal results are all readable per employer through the API, so a full history export is possible with the customer's consent.

**Implication for WeldSuite:** Loket fits approach A almost exactly. WeldHR collects hours, leave and allowances, maps them to the employer's Loket components, and PATCHes them per period. The accountant still runs and approves payroll in Loket. WeldSuite reads back payslips for the HR portal and journal runs for WeldBooks. Employee onboarding should create a concept employee, not a full employee.

### 2.2 Nmbrs (Visma)

- **API.** New REST API; "All new integrations should use the REST API". The SOAP API is deprecated and "will be retired in 2027" (https://api.nmbrs.nl/); an older support article puts the date at 1 March 2027 (search summary of https://support.nmbrs.nl/hc/nl/articles/205903718-API). Reference on Stoplight (https://nmbrs.stoplight.io/, JavaScript-rendered, not readable here). Developer portal for registering an integration, OAuth credentials, scopes and the partner account (https://developer.payroll.nmbrs.com/).
- **Auth.** Third party: OAuth2 authorization code via `identityservice.nmbrs.com` plus an `X-Subscription-Key` header per API product, base URL `api.nmbrsapp.com` (https://apis.apievangelist.com/store/nmbrs-wage-components-api/). StackOne confirms that an integration must be registered in the Nmbrs developer portal and subscribed to an API product (https://docs.stackone.com/connectors/nmbrs). Rate limit in an older support article: 150 calls per second under fair use (search summary of the same support article).
- **Sandbox.** A SOAP sandbox exists (`api-sandbox.nmbrs.nl`); a REST sandbox was not confirmed (https://api.nmbrs.nl/).
- **Write (via StackOne's connector list, 21 write actions).** Create employee, update personal info and BSN, create address, create/update bank account, create/update contract and employment, create salary, create fixed and **variable hours**, create fixed and **variable wage components**, update department, function, manager and cost center, create and delete leave requests (https://docs.stackone.com/connectors/nmbrs).
- **Read.** Employee history tables (personal info, addresses, bank accounts, contracts, employments, salaries), payslip per period (PDF), document content, company payroll runs and payrun employees, salary tables, hour codes, wage-component catalogs, absences, leave balances and requests (same source). A journal (loonjournaalpost) endpoint was not confirmed in REST; the pricing page lists a journal export in every plan (https://nmbrs.com/business/pricing).
- **Webhooks.** None found. The Nmbrs App Store "Webhooks" entry says the integration does not exist yet (https://appstore.nmbrs.com/s/webhooks).
- **Partner program.** API docs free; an App Store listing comes with a partner licence and integration managers; licence cost and revenue share not stated (search summary of https://www.nmbrs.com/en/developer). Nmbrs reports 180+ partners on the developer portal and 300+ on the developer page.
- **Pricing, business.** Essential/Advanced/Advanced Pro per month by headcount: 10 employees €71 / €102; 100 employees €435 / €693 / €1,549; 500+ €2,019 / €3,319 / €7,239. Billed on active employees paid in the month, zero-hour workers only in months with paid hours, month-to-month. Loonaangifte, journal and pension-reporting exports and jaaropgaven are included (https://nmbrs.com/business/pricing).
- **Pricing, accountants (wholesale signal).** Packages by payslips per month: 60 for €139, 120 for €259, 270 for €579, 550 for €1,199, 1,000 for €1,999, 2,500 for €4,499, 5,000 for €7,399, 10,000 for €11,599; implementation billed separately (https://www.nmbrs.com/accountant/pricing). That is €2.32 per payslip at the bottom and €1.16 at the top. Third party: one accountancy firm's 2025 tariff card lists "Gebruik salarispakket Nmbrs" at €3.70 per employee per period (https://omnyacc.nl/files/Tariefkaart_2025_Werkgever_verzuim_en_Pensioen.pdf).
- **Migration away.** Payslip PDFs, payruns, and salary/contract/bank history are readable over REST. Year-to-date cumulatives were not confirmed in REST.

**Implication for WeldSuite:** Nmbrs is the second integration for approach A, with a richer write surface than Loket for hours and wage components. The spread between the accountant price (about €2 per payslip) and the business list price (about €4 to €7 per employee) is the only published wholesale margin in the Dutch market, but it is reached by becoming an accountant-style payroll bureau that processes payroll in Nmbrs with its own staff. No public API to start or approve a payroll run was found.

### 2.3 Employes

- **API.** REST v4 at `connect.employes.nl/v4`, OpenAPI 3.0.1 (https://employes.readme.io/docs/getting-started). Endpoints include `POST /companies` (create company), `GET /companies`, employees (create, patch, sync, onboarding by email), employments with contracts, salaries, hours, tax details, terminate/undo termination, annual statement per year, `POST /{companyId}/payruns` (create a payrun for a month), `POST /payruns/{id}/employee/{id}` (hours worked and wage components), payrun entries, payrun payslips download, and the regulations catalog (reference index at https://employes.readme.io/reference; createcompany and createpayrun pages under the same path).
- **Auth.** A bearer token that a user generates in their own account, valid for one year. No OAuth, no partner app registration (https://employes.readme.io/docs/authentication). No sandbox; use a test company (getting-started page). Rate limit 5 requests per second (https://employes.readme.io/docs/rate-limits).
- **Write.** Payrun data is limited to hours worked (for hourly workers) and a fixed list of 14 wage components ("regulations"): gross supplements, expense claims, meal allowances, vrije ruimte, public transport, km allowance above the tax-free rate, overtime and extra hours, irregular-hours supplement, home-working allowance and wage advances (https://employes.readme.io/docs/regulations.md, https://employes.readme.io/docs/importing-data-to-a-payrun). Data can only be added to a payrun in status `pending`. Time-off, sick leave, time registration and expenses endpoints are in testing (https://employes.readme.io/docs/future-updates.md, updated 16 March 2026).
- **Read.** Companies, employees, employments, payruns, payrun entries, payslips, annual statements. A payrun journal endpoint was removed in v4 (https://employes.readme.io/changelog/changelog-v4.md).
- **What Employes does.** Loonaangifte goes to the Belastingdienst automatically after each run, pensioenaangifte to the pension fund, in every plan; salaries are paid out ("verlonen en uitbetalen") (https://www.employes.nl/tarieven/, https://www.employes.nl/).
- **Pricing.** Salaris €7 per payslip + €29.95/month; Salaris & HR €9 + €39.95; DGA €16.50/month; **Accountancy €5 per payslip + €25/month** with 10% off at 3 to 9 clients, 15% at 10 to 24 and 20% at 25+; no setup fee, monthly cancellation, only employees who worked are billed (https://www.employes.nl/tarieven/).
- **Partner / white-label.** No developer partner program, reseller program or white label was found; "Vind je partner" lists accountants for customers (https://www.employes.nl/koppelingen).
- **Migration away.** Annual statement and payslip endpoints make history extraction possible per employment.

**Implication for WeldSuite:** Employes is the only Dutch engine where an outside system can create the employer, the employees and the period data over the API, with filing, pension reporting and payouts done by Employes. That is close to approach B. The gaps are commercial and operational: personal tokens instead of OAuth, no sandbox, no white label, a narrow wage-component list, no published way to approve a payrun over the API, and an owner (Shine, a business-banking platform) that could see WeldSuite as a competitor. At the Accountancy rate with 20% off (€4 per payslip + €20/month per client) against Employes' own €7 + €29.95 retail, there is room for a margin, if Employes accepts a software company on that plan.

### 2.4 Exact Online (payroll)

- **API.** Exact Online REST, OAuth2, app registered in the App Center; payroll needs the "Hrm payroll" scope and the Payroll package (https://start.exactonline.nl/docs/HlpRestAPIResourcesDetails.aspx?name=PayrollVariableMutations).
- **Write.** Only `payroll/VariableMutations` (GET, POST, PUT): per employee number, payroll year and period, a type (codes 1 to 21 for worked, ill, leave, care leave, partner leave, unpaid leave, parental and maternity leave, or 7 = payroll component), entry type (quantity, amount, percentage) and value (same page). HRM cost centers and cost units are writable.
- **Read only.** Employees, Employments, EmploymentContracts, EmploymentSalaries, PayrollComponents, PayrollTransactionsByPayrollYear, tax settings, absence and leave registrations, plus sync endpoints for bank accounts and employees (https://start.exactonline.nl/docs/HlpRestAPIResources.aspx?SourceAction=10). Employees cannot be created over the API.
- **Partner program.** Free partner registration; a developer subscription of €15/month (excl. VAT) is required to manage apps, link several customers to one app or list in the App Store; listing requires Exact's approval (undated page: https://www.exact.com/app-store/developer).
- **Pricing.** Not confirmed. Third party: "from €92.50/month" with 25 payslips included (https://www.hr.software/reviews/exact-online).

**Implication for WeldSuite:** Exact is a cheap integration to build (one write endpoint, OAuth, small developer fee) and is worth adding later because so many SMBs keep their books in Exact. Its payroll API cannot onboard employees, so it only suits the mutations part of approach A.

### 2.5 AFAS Profit

- **API.** REST (JSON) and SOAP (XML) with the same capabilities; a token generated in an **AppConnector** that the customer creates and limits to specific GetConnectors and UpdateConnectors; 75 MB per call; GetConnectors can return changed and deleted records via audit fields (https://help.afas.nl/help/NL/SE/api.htm). No webhooks or OAuth are mentioned.
- **Write.** `KnEmployee` (employees), `HrCompMut` (loonmutaties, with parameters VaD1 to VaD3 per wage component), `HrIllness` (absence) (https://help.afas.nl/help/NL/SE/App_Conect_UpdDsc_131.htm).
- **Partner program.** Product partners with certified integrations; demo environments only for licence holders or members of the AFAS partner program (api.htm; https://help.afas.nl/help/NL/SE/App_Prtner.htm). Partner network terms dated April 2026 exist, but the tariff part was not readable (third-party summary of https://partner.afas.nl/openen-downloadbaar-bestand-prs/afas-partnernetwerk-voorwaarden).
- **Pricing.** Not checked.

**Implication for WeldSuite:** AFAS customers are larger than WeldSuite's target and usually work with an implementation partner who configures the connectors. AFAS belongs in the file-export presets, not in the first API integrations.

### 2.6 Visma Raet Youforce, ADP and others

- **Youforce** targets large and public-sector employers. API credentials come from Youforce support (third party: https://help.kombo.dev/hc/en-us/articles/25662408679825-Visma-Raet-Youforce-How-do-I-link-my-account). Kombo reads employees and employments and can create an employee, which runs asynchronously through a Youforce HSS workflow and needs customer-specific payroll codes (https://docs.kombo.dev/hris/connectors/youforce.md). Not a WeldSuite target.
- **ADP Nederland** sells managed payroll to foreign companies with 1 to 30 Dutch employees (https://nl.adp.com/onze-diensten/salarisadministratie/international-managed-payroll-services.aspx). The ADP Marketplace requires a Developer Participation Agreement and ADP security review (third-party summary of https://partners.adp.com/gettingstarted). Not relevant for Dutch SMBs.

### 2.7 Staffing back offices (integration angle only)

- **Easyflex** has a REST front-office API (EF2GO) with webhooks, plus SOAP webservices and "dataservices". Endpoint names include hour imports (`wm_urenimport`, `ds_fw_timecard_insert`), placements, invoices and payroll outputs (`fw_loonspecificaties`, `fw_jaaropgaven`) (https://www.easyflex.net/dataservice/docs/Frontoffice%20%28EF2GO%29/). API keys come from the Easyflex account manager with IP whitelisting (third party: https://help.recruitrobin.com/en/articles/8693793-how-to-connect-easyflex).
- **Mysolution** runs on Salesforce and has had its own payroll module since 2014 (https://www.mysolution.com/en/colleague-speaking-wilma-steenblik). Public payroll API docs were not found.
- **SETU** is the Dutch staffing message standard: Timecard, Assignment, HumanResource, StaffingOrder and SETU Invoice; v1.4 (XML) has run over Peppol since June 2024, and v2.0 adds JSON and international fields (https://prod.econnect.eu/en/docs/learn/document-formats/formats/setu). It is mandatory under comply-or-explain for public bodies (third-party summary of a TenderNed document).

**Implication for WeldSuite:** staffing agencies already have payroll inside their back office. For them, WeldSuite's useful output is approved hours per placement, ideally as SETU Timecard v1.4/v2.0 or through Easyflex's hour import, feeding both pay and client invoicing. Replacing their payroll engine is a much harder sale.

## 3. Embedded and white-label payroll (approach B)

### 3.1 What "embedded" means here

- **EOR**: the provider is the legal employer, files and pays, and invoices the customer. Deel Embedded is explicitly this: "Deel acts as the Employer of Record, handling compliance, payroll, and statutory obligations" (https://developer.deel.com/api/embedded/eor-overview). EOR is no use to a Dutch SMB with its own BV, and none to a staffing agency, which must itself be the employer.
- **Payroll for the customer's own entity**: the customer stays the employer (inhoudingsplichtige); the provider calculates, submits loonaangifte and pension returns on its behalf and may move the money. This is what approach B needs.
- **Money movement.** Employes pays out salaries itself (https://www.employes.nl/). Remote pays employees and tax authorities from a funded "virtual payroll wallet" in some countries and otherwise gives a bank file (https://remote.com/global-payroll). For Nmbrs and Loket, the API docs show SEPA payment details on the employee, but a payout service was not confirmed.

### 3.2 Dutch engines as the back end of approach B

| Route | Who files and pays | What WeldSuite would be | Blocking issue |
|---|---|---|---|
| Employes via API | Employes files loonaangifte and pension, pays out | Owner of an Accountancy account that creates client companies and pushes data | No partner program, OAuth or white label; payrun approval over API not documented |
| Nmbrs accountant licence | Nmbrs generates the returns; the licensee runs payroll | A payroll bureau that operates Nmbrs, pushing mutations via API | Needs payroll staff; no API to run payroll found; Nmbrs is now a competing suite |
| Loket via accountant model | Same as Nmbrs | Same | Wholesale terms not public |

### 3.3 Global providers with Dutch coverage

| Provider | Own-entity payroll in NL | API / embedded | Pricing seen | Notes |
|---|---|---|---|---|
| **Remote** | Netherlands listed as a Payroll country; monthly payroll, cut-off on the 10th (https://remote.com/country-explorer/netherlands); homegrown engine, "We don't use third-party providers" (https://remote.com/global-payroll) | White-label embedded partnership covering EOR, Global Payroll and contractors (https://remote.com/embedded). Partners can create companies, create `global_payroll_employee` employments engaged by the customer's legal entity, add pay items, read payroll runs, payslips (PDF) and GL reports (CSV), and **create per-company pricing plans from partner templates** (https://developer.remote.com/docs/getting-started-for-partners.md, https://developer.remote.com/reference/post_v1_employments.md, https://developer.remote.com/reference/post_v1_companies_company_id_pricing-plans.md) | Payroll $29 per employee/month plus an implementation and a payroll delivery fee; EOR $699 (https://remote.com/pricing) | Access starts with a discovery call and NDA; commercial terms not public |
| **Deel** | Global Payroll API covers employment, adjustments, shifts and shift rates, gross-to-net reports and payslips in "130+ countries" (https://developer.deel.com/api/global-payroll); NL not confirmed on the pages read | Embedded is EOR only; Partner API for App Store listings | EOR $599; Global Payroll not priced (https://www.deel.com/pricing/) | |
| **Rippling** | Supports payroll "via your entities"; NL not confirmed (https://www.rippling.com/global-payroll) | API and partner program, no embedded payroll described | Platform from $8/user | |
| **Salsa** | Docs describe US federal and state tax setup only (https://docs.salsa.dev/llms.txt) | Embedded payroll (Express UI, Advanced GraphQL) | Not public | No NL evidence |
| **Playroll** | NL not confirmed | White label offered, referral program; no API mentioned (https://www.playroll.com/pricing) | EOR from $399 | |
| **Oyster** | Own-entity payroll not priced; NL not confirmed | Developer API and Oyster Embedded for hiring (https://www.oysterhr.com/pricing) | EOR $699 | |
| **Papaya Global** | Not verified (pricing page blocked) | Not verified | Not verified | |

**Implication for WeldSuite:** Remote is the only verified approach-B partner with white label, own-entity payroll in the Netherlands and partner-controlled pricing. It is aimed at companies paying people abroad, its NL product depth (sector CAOs, sector pension funds, 4-weekly periods, holiday-pay reservations, WKR) is unknown, and $29 per employee before fees is above Dutch SMB prices (Nmbrs Essential is €4.35 to €7.10 per employee). It could serve WeldSuite's customers with staff in several countries; it is not a Dutch SMB payroll product.

### 3.4 Reseller economics at a glance

| Route | Wholesale signal | Retail reference | Can WeldSuite set its own price? | Revenue share / referral |
|---|---|---|---|---|
| Nmbrs accountant licence | €2.32 → €1.16 per payslip by volume | Nmbrs business €7.10 (10 staff) → €4.35 (100 staff) per employee | Yes, accountants bill clients themselves; one firm lists €3.70 per employee per period (third party) | Not published |
| Employes Accountancy | €5 per payslip + €25/month, up to 20% off | €7 to €9 per payslip + €29.95 to €39.95/month | Plan is for firms serving clients; whether a software company qualifies is unconfirmed | Not published |
| Loket | Not public | Not public | Accountant channel exists | Not published |
| Remote Embedded | Not public | List $29 per employee/month + fees | API supports per-company pricing plans | Not published ("revenue engine" language only) |
| Deel, Rippling, Playroll, Oyster | Not public | EOR $399 to $699 | Playroll offers white label; others not for own-entity payroll | Playroll has a referral and affiliate program |

### 3.5 Leaving a provider later (stepping stone to C)

- Readable history per provider: Loket payroll run results, payslips, year-end statements and journal results (2.1); Employes annual statements, payslips and payrun entries (2.3); Nmbrs payslip PDFs, payruns and salary/contract/bank history (2.2); Exact `PayrollTransactionsByPayrollYear` (2.4); Remote payroll runs, employee details, payslips and GL reports (3.3).
- A switch mid-year means the new engine needs the year-to-date cumulatives for the jaaropgaaf and for capped premiums; a switch on 1 January avoids most of that. How each provider exports cumulatives was not confirmed.

**Implication for WeldSuite:** under A or B, import and keep structured results for every run: per employee and period the gross pay, each wage component, fiscal wage, social-security wages, loonheffing, employer premiums, pension, net and payment, plus the journal. PDFs alone are not enough to take over the calculation later.

## 4. Unified HRIS and payroll APIs with Dutch coverage

| Vendor | NL systems covered | Read / write for NL | Pricing model |
|---|---|---|---|
| **StackOne** | Nmbrs (66 actions: 45 read, 21 write), Loket (61 actions: 33 read, 28 write) | Nmbrs: variable hours, variable wage components, salaries, contracts, bank accounts, leave requests. Loket: create/update payroll period data, leave, absences, wages, working hours, concept employees (https://docs.stackone.com/connectors/nmbrs, https://docs.stackone.com/connectors/loket) | OEM Core free with unlimited end customers, then usage credits (1 per call; $20 to $60 per 20,000); OEM Enterprise custom (https://www.stackone.com/pricing) |
| **Kombo** | Nmbrs, Loket, AFAS, Visma Raet Youforce, Visma YouServe, Mirus, plus Personio, HiBob, Deel, Remote, Officient (https://docs.kombo.dev/hris/connectors.md) | Mostly read (employees, employments, groups, legal entities, bank accounts); create employee for Nmbrs and Youforce; Loket and AFAS read plus API passthrough (connector pages under https://docs.kombo.dev/hris/connectors/) | Annual platform fee plus a per-connected-customer fee, no numbers published (https://www.kombo.dev/pricing) |
| **Apideck** | Visma Nmbrs, AFAS, Personio, Loket.nl, BambooHR, HiBob, Officient, Deel, SAP SuccessFactors (https://www.apideck.com/integrations/country/netherlands/hris) | Loket: 3 resources (employers, employees, departments), virtual webhooks (https://developers.apideck.com/apis/hris/loket-nl/overview) | Per active consumer: €599/month for 25 → €4,250/month for 500 (https://www.apideck.com/pricing) |
| **Merge** | Nmbrs only (Company, Employee, Employment, Location, Team) (https://www.merge.dev/integrations/nmbrs) | Read | Not checked |
| **Unified.to** | AFAS Profit (beta): HRIS Employee, Company, Group plus passthrough (https://unified.to/integrations/afas.md); no Nmbrs or Loket page | Employee/company CRUD (third-party summary) | Not checked |
| **Finch** | No Dutch provider visible (https://www.tryfinch.com/integrations) | n/a | n/a |

**Implication for WeldSuite:** only StackOne exposes the mutation writes approach A needs, and its OEM tier costs little to start. But a unified API is a wrapper: WeldSuite still registers with Nmbrs and gets a Loket client, still maps each employer's wage components, and still handles each provider's period and approval rules. With two target systems and good native APIs, building Loket and Nmbrs directly is a reasonable choice; StackOne is a fallback if direct partner access stalls, not a shortcut around it.

## 5. How HR tools already integrate with Dutch payroll

- **Personio → Loket** (native, announced 20 February 2025, live from March 2025; https://www.personio.com/about-personio/press/partnership/loket/). Employee and compensation data go to Loket; payslips and payroll documents come back to Personio. From a chosen "compensation start date" Personio is the source of truth and overwrites edits made in Loket; only euro amounts and monthly recurring compensation are supported; the payroll admin reviews the synced changes in Loket each month and adds out-of-scope data by hand. Requires a Dutch legal entity; one Personio entity links to one Loket administration (third-party summaries of Personio help articles https://support.personio.de/hc/en-us/articles/34406718265373-Overview-of-the-Loket-integration and https://support.personio.de/hc/en-us/articles/35527325688605-Loket-integration-Sync-compensation-data; the help center blocks direct fetches).
- **Personio → Nmbrs** is run by a partner, worldofwork, not by Personio (https://support.personio.de/hc/en-us/articles/14951759607197-Nmbrs-by-worldofwork).
- **HiBob ↔ Nmbrs**: personal, employment, compensation and benefits and org data go to Nmbrs; payslips, annual summaries and payroll data come back (https://www.hibob.com/marketplace/nmbrs). No HiBob–Loket integration was found.
- **Officient ↔ Nmbrs** (free): Officient imports the employee list, wage history, leave types and history and payslips from Nmbrs, and pushes the days-off calendar and personal-data changes (https://marketplace.officient.io/listings/nmbrs).
- **Tellent HR → Nmbrs**: creates or updates employees with name, BSN, start date, IBAN and address; clearing a field in Tellent does not clear it in Nmbrs (https://support.tellent.com/en/articles/15002207-nmbrs-payroll-integration).
- **Factorial**: no Dutch payroll connector seen; it offers structured export files and an API for non-DATEV payroll (https://factorialhr.de/apps/kategorie/146390751-Payroll).
- **Time and planning tools push hours to Loket**: TimeChimp exports hours per period for employees previously imported from Loket, matched on email (https://help.timechimp.com/en/articles/7262276-how-to-connect-loket-to-timechimp); Shiftbase generates variable-data import files (https://marketplace.shiftbase.com/loket); Eitje imports employee data nightly and sends hours, leave, sick days, meals and allowances (https://eitje.app/en/partners/loket-nl).
- **Employes** integrates mainly with bookkeeping tools (Moneybird, e-Boekhouden, Yuki, Twinfield, Visma eAccounting) and Shiftbase (https://www.employes.nl/koppelingen).

The common pattern: master data and salary changes are pushed when they change, variable data once per period before the cut-off, payslips come back after the run, and someone at the payroll side still reviews and approves. Nobody runs payroll from the HR tool.

**Implication for WeldSuite:** matching Personio's Loket integration is the bar for approach A. WeldSuite should decide per field which system is the source of truth, show the period's pending changes before sending, and pull payslips back into the HR portal.

## 6. File-based export

- **Loket "Import variabele gegevens"** (product 50 must be activated per employer). CSV, semicolon-separated, decimal comma, CRLF. Header: `aanslnr;persnr;ploeg;` then optional `verdelingseenheid` (cost split unit) then the payroll component numbers; each row holds the values per employee. Hours are decimal (1h15 = 1,25), hours may not be negative or ≥ 1000, the shift ("ploeg") must exist, and unknown component numbers are rejected. Loket can export a prefilled employee list ("Export voor import → Variabele gegevens") to build the file from. Example from the manual: `aanslnr;persnr;ploeg;2;15;16;284;367;372` then `395;6;1;12,5;121;2;100;68;15`, where 2 is holiday hours, 15 and 16 overtime at 100% and 125%, 284 a personal allowance, 367 travel and 372 phone allowance (Loket manual version 2015-1, https://helpdesk.loket.nl/hc/nl/article_attachments/360013717219).
- **Nmbrs**: a company-level Excel template ("Wage Components Variable"), only the "Wage Components Var" tab is read; hours use hour code H2100; imports only into the current period; "import" adds rows, "update" overwrites everything in the file; imports cannot be undone, so test in the sandbox (third-party summary of Nmbrs support articles https://support.nmbrs.com/hc/en-us/articles/360015900692 and https://support.nmbrs.com/hc/en-us/articles/360016128531; the help center blocks direct fetches).
- **AFAS**: an import parameter is set per wage component in the CLA (e.g. monthly overtime hours), then variable wage entries are imported (https://help.afas.nl/help/EN/SE/Pay_Config_Entry_Entry_Import.htm).
- **Exact**: no file import for payroll mutations was confirmed; the API fields of `VariableMutations` (2.4) are the reference.
- **No shared standard.** Every system keys the file on its own employer number, employee/employment number and component codes.

What a generic WeldSuite "payroll mutations" export needs per line:

| Field | Why |
|---|---|
| Employer external id (Loket aansluitnummer or employer GUID, Nmbrs company id, Exact division, Employes company id) | Every target keys on it |
| Employment external id (Loket persnr verloning / employment GUID, Nmbrs employee id, Exact EmployeeHID) | Loket and Exact key on employment, not person |
| Payroll year, period number, period type (month / 4 weeks / week) | Loket and Exact require them; 4-weekly payroll has 13 periods |
| Component code in the target system | Mapped per employer from a WeldSuite pay item |
| Value type (hours, days, amount, percentage) and value | Exact distinguishes quantity, amount, percentage |
| Cost center / cost unit (Loket verdelingseenheid) | Needed to split cost per client for staffing |
| Shift / schedule code (Loket ploeg) where required | Loket validates it |
| Source reference and idempotency key | To prevent double sending and to trace corrections |
| Status (draft, approved, exported, accepted, rejected) | Imports are hard to undo |

**Implication for WeldSuite:** the export needs a per-employer mapping table from WeldSuite pay items (regular hours, overtime 125%, leave hours by type, sick hours, travel allowance, bonus) to each provider's component code, plus period locking after export. Per `codebase.md`, WeldHR currently stores leave in days and has no pay codes; both Loket and Exact take hours and typed components, so those gaps block A as well as C.

## 7. Comparison and recommendation

| Provider | API quality | Write capabilities | Embedded possible | Partner effort | Pricing to end customer | Staffing suitability |
|---|---|---|---|---|---|---|
| Loket.nl | Good: REST, OAuth2, acceptance env, OpenAPI | Payroll period data, employments, wages, working hours, leave, absence, concept employees | No (accountant model only) | Apply for client; per-operation production scope | Not public | Medium: cost units, 1/4/1-week periods |
| Nmbrs | Good, new REST; SOAP retires 2027 | Variable hours and wage components, salaries, contracts, bank, leave requests, employees | Only as accountant-licence bureau | Developer portal registration + subscription key; licence terms unpublished | €71/month at 10 staff to €2,019 at 500+ (Essential) | Medium |
| Employes | Simple REST, personal tokens, no sandbox, 5 rps | Companies, employees, employments, salaries, payrun hours and 14 wage components | Closest Dutch option (provider files and pays) | None formal; commercial deal unclear | €7 per payslip + €29.95/month | Low: narrow components |
| Exact Online | Good platform API, payroll mostly read-only | VariableMutations only | No | €15/month developer plan, app review | Not confirmed | Low |
| AFAS Profit | Capable, customer-created tokens | Employees, loonmutaties, absence | No | Certified partner program | Not checked | Low (mid-market) |
| Youforce | Restricted, via support | Async employee creation | No | Provisioned by Visma Raet | Not public | Low (enterprise) |
| Easyflex / Mysolution | EF2GO REST + SOAP; Mysolution unclear | Hours import (by endpoint name) | No | Account-manager key | Not public | High, but they are the payroll |
| Remote | Strong, documented partner API | Companies, employments, pay items, pricing plans | Yes, white label, NL listed | Discovery call, NDA, commercial deal | $29/employee/month + fees | Low |
| Deel | Good | Global Payroll inputs, G2N, payslips | EOR only | App Store or Embedded (EOR) | EOR $599 | Low |

**Approach A, first integrations.**
1. **Loket API**: the documented variabele-gegevens write, payroll results, payslips and journal runs in one partner API, a large SMB-plus-accountant base, an owner without its own accounting suite, and Personio's integration as proof the flow works.
2. **Nmbrs API**: the other half of the market and the richest write surface for hours and wage components. Build it second, knowing Nmbrs now competes with WeldSuite in Dutch SMB software.
3. **Generic CSV/Excel export** with presets for the Loket CSV and the Nmbrs template, and mapping notes for AFAS and Exact, so every other customer (and every accountant on another package) is covered from day one. Exact's `VariableMutations` API is the cheapest next API after these.

Approach A earns nothing per payslip unless WeldSuite charges for the payroll-prep feature itself, which is how Personio and others bundle it.

**Approach B for the Netherlands.** No realistic white-label Dutch payroll exists off the shelf today. The two live options are commercial conversations, not integrations: (a) Employes, if it will let WeldSuite create and run client companies on accountancy-level pricing with OAuth or partner tokens and an API to approve payruns; (b) Remote Embedded, for customers with staff in several countries, accepting a US-dollar price above Dutch SMB levels. Becoming a payroll bureau on Nmbrs or Loket licences gives the best published margin but turns WeldSuite into a service business with payroll staff.

Given no current demand, a margin goal and an owner willing to own liability, the sensible order is A now (Loket, Nmbrs, export), store full payroll results from day one, ask Employes and Remote for partner terms in parallel, and treat an own engine (C) as the long-term target that this stored data feeds.

## Could not verify

- Loket's partner fees, production approval criteria, rate limits, end-customer pricing and any white-label or reseller program for software companies.
- Nmbrs partner licence cost and revenue share, a REST sandbox, REST endpoints for journals and year-to-date cumulatives, any API to start or approve a payroll run, and current webhook plans. The Stoplight reference and support center could not be read directly; Nmbrs write capabilities come from StackOne's connector list.
- Whether Employes accepts a software company on its Accountancy plan, whether a payrun can be approved over the API, and whether Shine has plans for the API.
- Exact Online payroll pricing and whether a CSV import for payroll mutations exists; whether the €15/month developer fee is current.
- AFAS partner tariffs and Profit payroll pricing.
- Who owns Easyflex; Mysolution's payroll API; whether Loket or Nmbrs pay out salaries themselves or only produce SEPA files.
- Remote's depth for Dutch payroll (CAOs, sector pension funds, 4-weekly periods, loonaangifte filing by Remote) and its partner commercial terms; Deel, Rippling, Playroll, Oyster and Papaya Global coverage of own-entity payroll in the Netherlands; Salsa coverage outside the US.
- The exact legal split of liability when a provider files loonaangifte for an employer. This research assumed the employer stays the inhoudingsplichtige; it was not checked against a Belastingdienst source.
- How each provider handles mid-year migration (importing or exporting cumulatives).
- User opinions on the Personio, HiBob and Officient payroll integrations: no reviews were gathered before the search budget ran out. SnelStart's payroll offering and Loket's current customer counts (the homepage counters did not render) also remain unconfirmed.
