# WeldHR: payroll for the Netherlands and the United States

Status (9 October 2026): **being built as an own engine for both countries**
(see "Build" below). The research, with sources, is in
[weldhr-payroll-research/](weldhr-payroll-research/README.md): Dutch and US
payroll rules, Dutch and US providers, competitors, staffing and BPO
specifics, and a map of the code payroll would plug into. The recommendation
further down (export first, own engine behind a demand gate) was the
research's; the owner chose differently on 9 October.

## Build (9 October 2026)

The owner asked for payroll "like Employes does", in the Netherlands and the
United States, in one PR. Decisions:

| | Netherlands | United States |
|---|---|---|
| Model | Own engine (approach C), like Employes | Own **self-service** engine: WeldSuite calculates, the employer deposits and files |
| Why not full service | n/a | No US entity; IRS reporting agents need US-citizen officers (Pub 3112); money movement needs a US company |
| v1 employers | No CAO, insured (non-sector) pension, DGA payroll | Federal + AK, FL, NV, NH, SD, TN, TX, WA, WY + CA, NY, IL, PA, GA, NC, NJ, MA, AZ, CO. No local taxes |
| Pay frequency | Monthly | Weekly, biweekly, semimonthly, monthly |
| Money | SEPA pain.001 salary batch (category purpose SALA) the employer uploads; loonheffingen paid with the betalingskenmerk | NACHA PPD credit file the employer uploads; deposits through EFTPS |
| Filing | Loonaangifte XML built per period; sent over Digipoort behind the `weldhr-payroll-digipoort` flag once the owner has the ODB subscription, PKIoverheid certificate and Logius connection | 941, 940, W-2/W-3 and state withholding/SUI figures and documents; the employer files |
| Documents | Payslip (loonstrook), jaaropgaaf | Pay stub, W-2 employee copy |
| Billing | Each final payslip is metered in `payroll_usage_events` (master DB); a Stripe price comes later | same |

Architecture:

- **`@weldsuite/payroll-domain`** (`packages/domains/payroll`): pure engines.
  `calculatePayslip(input)` takes everything one payslip depends on (period,
  pay, components, run inputs, year-to-date accumulators, tax elections,
  employer rates) and returns lines, totals, new accumulators and the figures
  the filings need. Rules are versioned per tax year (`nl/rules-2026.ts`,
  `us/federal-2026.ts`, `us/states/<st>.ts`). Also: pay periods, SEPA, NACHA,
  the loonaangifte builder, US form aggregation and the payslip PDF
  (`pdf-lib`, runs in Workers). Contract: `src/types.ts`.
- **Tenant schema** `packages/core/db/src/schema/weldhr-payroll.ts`:
  employers, pay schedules, payroll profiles, effective-dated compensation,
  pay components and tax elections, pay runs with inputs, payslips (immutable
  once final, PDF in R2), filings. BSN/SSN and bank details stay in the
  employee's encrypted sensitive block.
- **hr-api** `/api/weldhr/payroll/*`: setup, runs (draft → calculated →
  approved → paid), payslips, filings; employees get their payslips and sign
  their tax forms under `/api/weldhr/me/*` and in the workforce portal.
  Approval posts the journal to WeldBooks through `BooksInternal`
  (`payroll_imports`, source `weldhr`) when the employer is linked to an
  accounting entity.
- **Permissions** `payroll:read|prepare|approve|manage`; optional four eyes
  per employer (`require_separate_approver`). Events `hr_pay_run`,
  `hr_payslip`, `hr_payroll_filing` carry ids and status only.
- **Flag** `weldhr-payroll` gates the screens and the API.

Known limits of v1, to tell customers plainly:

- NL: no CAO rules, no UPA pension returns, no green table (benefits,
  pensions), no 4-weekly or weekly pay, no staffing (ABU/NBBU). The 2027 rates
  are provisional until the Belastingdienst publishes the Prinsjesdag
  calculation rules (13 October 2026) and the December version.
- US: no local taxes (NYC, Yonkers, PA EIT/LST, OH, MI, KY, MD counties, IN
  counties, OR transit); no multi-state reciprocity beyond the work state; no
  garnishments; the employer files and pays every return itself.

WeldHR runs employees, attendance, shifts, leave and a white-label portal for
employees and client companies (`.claude/weldhr-plan.md`). It has no payroll.
Pay is one number in the encrypted employee blob. This plan decides how deep
WeldSuite goes into payroll in the Netherlands and the United States, and in
what order.

## Decisions taken with the product owner

- **Countries:** the Netherlands and the United States first.
- **Customers:** regular SMBs paying their own staff, and staffing/BPO agencies
  whose employees work at client companies, where hours drive both pay and
  client invoices.
- **Payroll is a revenue line:** a paid product with margin, not a free
  checkbox.
- **No concrete customer demand yet.** This is a strategic bet.
- **WeldSuite has no US legal entity** and no plan for one.
- **The owner accepts legal responsibility** for filings and payments, so an
  own engine is acceptable in principle.

The WeldBooks US plan (`docs/plans/weldbooks-us.md`) put payroll out of scope
and planned a payroll-journal import. That stays true for WeldBooks: payroll
lives in WeldHR, and WeldBooks receives the journal.

## The three approaches

| | A. Prep + export | B. Embedded provider | C. Own engine |
|---|---|---|---|
| What WeldSuite does | Collects hours, leave, pay changes and one-offs, gets them approved, and sends them to the customer's payroll | Runs payroll in WeldSuite's UI; a provider API calculates, files and pays | Calculates gross to net, files the returns, produces payslips and payment files |
| Who is the payroll provider of record | The customer's bureau or software | The provider (the employer signs the provider's terms) | WeldSuite |
| Revenue | A small add-on fee | Resale margin over the provider's wholesale price | The full per-payslip or per-employee price |
| Fixed cost | Low | Integration plus front-line support | A rules team, permanently |

Payroll is really four jobs: **collect inputs**, **calculate**, **file**, and
**move money**. The research separates them because the hard problems sit in
different places:

- **Inputs** are WeldHR's job under all three approaches: hours by pay code,
  leave, effective-dated pay, and for staffing, rate cards and client-approved
  timesheets.
- **Calculate and file** is where the revenue and the rules maintenance are.
- **Moving money** is what drives licences and the need for a US entity.
  WeldSuite should never hold payroll funds:
  - Dutch payroll software doesn't. It produces a SEPA salary batch and the
    payroll-tax payment, and the employer pays both from its own bank
    ([nl-rules.md](weldhr-payroll-research/nl-rules.md) §8).
  - In the US, the embedded provider moves the money.

## Recommendation

| Segment | Now | Later | Never (for now) |
|---|---|---|---|
| **NL SMBs** | A: export + Loket, then Nmbrs | C, scoped (no CAO, insured pension, monthly), once a demand gate is met | B: no Dutch embedded provider exists |
| **NL staffing agencies** | Staffing layer + A to their staffing payroll package (Easyflex, Mysolution, AFAS Flex) | Same | C: uitzend CAO, StiPP, phases and equal pay are a niche of their own |
| **US SMBs** | A as CSV exports | B on Check, after the first US customers sign; Gusto Embedded as fallback | C: no entity, money transmission, 50 states plus local taxes |
| **US staffing agencies** | Staffing layer + A | B on Check; Everee only if agencies become the main US segment | C |
| **BPO (both countries)** | Same as SMBs, plus per-FTE / per-seat / per-output billing | Same as SMBs | |

### Why

**The Netherlands is where an own engine is realistic, and where the revenue
is.** The facts behind that:

- **No certification is needed.** The Belastingdienst publishes the
  calculation rules, XML specs and test services for free. A filing channel
  (PKIoverheid certificate plus Logius Digipoort) takes 3–4 months
  ([nl-rules.md](weldhr-payroll-research/nl-rules.md) §4, §10).
- **Small teams have done it.** Employes built a Dutch SMB engine in about 11
  months with a small team ([competitors.md](weldhr-payroll-research/competitors.md) §3.8).
- **The market is consolidating into accounting-plus-payroll bundles:**
  - Exact Online with Salaris.
  - Cegid (which bought Shine, which owns Employes, in June 2026).
  - Visma's new Nmbrs suite (Nmbrs, Yuki, WeFact and Visionplanner since
    1 September 2026).

  Those are WeldSuite's Dutch competitors, and each has payroll inside.
- **There is no embedded option (B) to rent.** No Dutch provider sells white-label
  payroll ([nl-providers.md](weldhr-payroll-research/nl-providers.md) §3).
- **Export (A) earns little.** Personio and HiBob include it in their plans.

The costs are permanent:
- **Rule changes:** 4–5 Belastingdienst releases per tax year, minimum-wage
  changes every January and July, and occasional retroactive changes.
- **CAOs and mandatory pension funds:** each one is its own rule set and its
  own pension-return (UPA) integration.
- **Liability:** a 2023 appeal court held a payroll administrator liable for
  €75,143 for not flagging a lapsed CAO supplement
  ([competitors.md](weldhr-payroll-research/competitors.md) §5).

Rough arithmetic (ours, not from a source):
- The research estimates 1.5–2 FTE permanently on Dutch rules. At about
  €110k loaded per FTE, that's €165–220k a year.
- At €6 per monthly payslip (€72 per employee per year), about 2,300–3,100
  employees on WeldSuite payroll pay for the upkeep alone.
- Build cost comes on top: 3–4 engineers plus a payroll specialist for a year,
  then a full year running alongside existing payroll.

So C is a scale business: start it when there is evidence of demand, not
before.

**In the US, an embedded provider is the only sensible route.**
- **An own engine with filing (full-service C) is closed to WeldSuite as it
  stands:**
  - The IRS requires every principal and responsible official on an e-file
    application to be a US citizen or green-card holder (Pub 3112). Reporting
    Agents must hold that application, so a Dutch BV with Dutch directors
    can't be one.
  - Every payment rail checked wants a US business (Dwolla, Moov, Plaid
    Transfer, Modern Treasury, Stripe Treasury), or assumes you hold your
    own money transmitter licence (Stripe Global Payouts).
  - About 7,000 taxing jurisdictions, and 13 states plus DC with
    payroll-funded leave programs.

  ([us-rules.md](weldhr-payroll-research/us-rules.md) §7, §8, §10)
- **The self-service variant isn't attractive either.** Here the software
  calculates and the employer files and pays. It avoids the agent and licence
  problems but keeps the engine cost. The same citizenship rule appears to
  cover IRS software e-filing, so returns would be PDFs. The market is moving
  away from it: Wave went full-service in all 50 states in April 2025, and
  QuickBooks Desktop's self-file tier sells at $1–3 per employee (§10).
- **Precedent:** Xero gave up its own US engine in 2018 (an NZ$16.2m
  write-off) and launched "Xero Payroll powered by Gusto" in August 2026.
  HiBob runs on Gusto Embedded and Zoho's US payroll runs on Check. Only
  payroll-first companies run their own US engine
  ([competitors.md](weldhr-payroll-research/competitors.md) §6).
- **No US entity is needed for B.** The employer signs the provider's terms,
  and the provider is reporting agent and moves the money
  ([us-providers.md](weldhr-payroll-research/us-providers.md) §1).
- **The real blocker is having no US customers.** Providers want a concrete
  pipeline (§3).
- **Check fits best:**
  - The partner sets the end price.
  - Check says partners carry no credit or fraud loss.
  - Each earnings line has its own workplace, which multi-site agencies need.
  - It sells only through platforms, so it doesn't compete for the customer.
- **Gusto Embedded's catch:** on faster payment speeds, an unrecovered failed
  employer debit becomes the platform's after 90 days.

**US margin is unknown and may be thin.** Wholesale prices aren't published. A
third-party estimate ($35–70 base plus $6–10 per employee) against retail
($39–50 plus $6–12) leaves little. Get Check's real numbers before counting
on US payroll as a revenue line. It may end up mainly completing the suite for
WeldBooks US customers.

**For staffing agencies, the valuable part isn't payroll.** Rate cards with
separate pay and bill rules, timesheets approved by the client in the existing
portal, invoices from approved hours, and margin per placement are needed
under every approach. They can ship before any payroll
([staffing.md](weldhr-payroll-research/staffing.md) §4–5).

In NL:
- **Equal pay:** since 1 January 2026, the uitzend CAO requires "gelijkwaardige
  beloning", an equal-value package (it replaced inlenersbeloning). The client
  supplies its terms through a standard SETU JSON form.
- **G-rekening split:** agency invoices need it, 25% of the invoice including
  VAT, or 20% when VAT is reverse-charged.
- **Wtta:** agencies register from 1 November to 31 December 2026, and
  enforcement starts 1 January 2028.

### A fourth option for Dutch revenue sooner: a payroll bureau

Nmbrs and Employes sell to accountants at wholesale:
- Nmbrs: €1.16–2.32 per payslip, against €4–7 per employee retail.
- Employes: €5 per payslip, against €7–9 retail.

WeldSuite could run payroll for its customers on such a licence, with WeldHR
feeding the inputs. That brings Dutch payroll revenue years before an own
engine, but it is a service business. It needs salaried payroll
administrators, carries the same duty of care as the €75k case, and Visma
(Nmbrs) is now a direct competitor. Worth a commercial conversation with
Employes and Loket; not a default.

## Phases

Each phase ships behind a `weldhr-payroll` feature flag per country. Schema
changes come with drizzle-kit migrations, generated per PR and approved per PR
(CLAUDE.md rule).

### Phase 0: foundations (needed by every approach)

From [codebase.md](weldhr-payroll-research/codebase.md) §9:

1. **Legal employer:** each employee links to a WeldBooks accounting `entities`
   row (country, currency, employer tax ids: NL loonheffingennummer, US EIN
   and state accounts).
2. **Effective-dated compensation:** a `hr_compensations` history replaces the
   salary in the sensitive blob. Store amounts in plain columns behind
   `payroll:*` permissions. Keep national ids and bank details encrypted.
3. **Correct time:**
   - Attendance days in the employee's timezone, not UTC.
   - A public-holiday calendar per country.
   - Pay codes on hours: regular, overtime, night, weekend, on-call.
   - Attendance locks once a pay period closes.
4. **Leave in hours, with accrual and expiry:** NL statutory leave is 4 × weekly
   hours, and statutory days lapse 6 months after the year. Half days in the
   portal. A paid percentage per leave type (NL sick pay).
5. **US wage-and-hour data, needed even for export:**
   - FLSA status per employee.
   - A workweek definition per employer.
   - Earning types that separate the FLSA-required overtime premium from
     state overtime.
   - Structured work-site addresses.

   From tax year 2026 the W-2 reports qualified overtime in box 12 code TT,
   and that counts only the FLSA half-time premium per workweek. For staffing,
   that workweek spans all of a worker's client assignments
   ([us-rules.md](weldhr-payroll-research/us-rules.md) §1, §4).
6. **Permissions:** a new `payroll` object (`read`, `prepare`, `approve`,
   `manage`) separate from `employees:sensitive`, plus `payslips:self` for
   employees. Optionally require preparer ≠ approver.
7. **Audit:** pay-run approvals, payslip views, and bank-detail changes. A
   bank-detail change also notifies the employee, because changed bank details
   are the classic payroll fraud.
8. **WeldBooks bridge:** a `BooksInternal` `WorkerEntrypoint` exposing
   `postJournalEntry` (idempotent on `postingKey`) with `sourceType: 'payroll'`.
   Add payroll `SystemAccountRole`s:
   - gross wages
   - employer social charges
   - wage tax payable
   - pension payable
   - net pay clearing
   - holiday-pay accrual

   Map them in the NL chart (`1800`, `4110`, `4120`) and in the US chart when
   it lands. Add a department/client dimension on journal lines.
9. **Billing:** a Stripe price per paid employee per month (or per payslip in
   NL), metered from completed pay runs. First-party modules have no
   per-module price today.

### Phase 1: pay inputs and export (approach A, both countries)

- **Pay schedules and periods:** NL monthly or 4-weekly; US weekly, biweekly,
  semimonthly or monthly.
- **Pay inputs per period (Dutch "mutaties"):**
  - Approved hours by pay code from attendance.
  - Leave by type.
  - One-off earnings and deductions: bonus, allowance, expense reimbursement,
    advance.
  - New hires, changes and leavers.
- **A per-cycle change list** with a sync or export status per record, as in
  HiBob's Payroll Hub.
- **Pre-run checks** that block on errors and warn on unusual values, with a
  person approving the period.
- **Exports:**
  - NL: Loket and Nmbrs import formats, with mapping notes for AFAS and Exact.
  - NL staffing: an Easyflex export.
  - US: CSV for Gusto, QuickBooks Payroll, ADP RUN, Paychex Flex and
    Paylocity.
- **Results back in:**
  - Import payslips (PDF to R2, shown in My HR and the portal).
  - Import the payroll journal into WeldBooks: CSV first, provider APIs later.
- **Store full payroll results from day one** (gross, net, every line, year to
  date). That's what lets an own engine take over later without a mid-year
  history problem.

### Phase 2: the staffing layer (can run in parallel with phase 1)

From [staffing.md](weldhr-payroll-research/staffing.md) §4:

1. **Rate cards:** `hr_rate_cards`, versions and lines.
   - Pay and bill rules are separate per earn code, scoped client → client
     role → assignment.
   - The lines store how the bill rate is derived: fixed, markup, NL factor or
     margin.
2. **`hr_client_assignments` becomes the placement contract:**
   - employing entity and worksite;
   - approvers and billing contact;
   - PO number, cost centre and invoice group;
   - NL: CAO code and phase;
   - US: workers' comp class and FLSA status.
3. **Timesheets from attendance:**
   - Client approval in the existing client portal, audited.
   - Auto-approval after N days.
   - Clients see bill amounts and hours only, never pay.
4. **Two charge streams** from approved timesheets: payable (to payroll) and
   billable (to invoices). Overtime can be paid but not billed, and fees
   billed but not paid. In the US, someone decides how overtime across
   assignments is billed.
5. **WeldBooks invoices from billable charges:**
   - Grouped per client, PO and period.
   - The NL G-rekening split on the invoice, plus matching receipts across
     two bank accounts.
   - A credit check before new shifts.
6. **Margin:**
   - Estimated from a burden profile per country and client.
   - Then actual, from the imported payroll journal.
   - Show both markup and margin.
7. **NL compliance:**
   - SETU client-terms import and the equal-value package decision.
   - Phase counters per employee.
   - Agency documents with expiry dates (Waadi, SNA, Wtta admission), shown
     to clients.
8. **BPO billing:** the same rate-card lines with FTE-month, seat-month or
   transaction units. Output quantities and SLA credits come from
   `hr_kpi_values`.

### Phase 3: Dutch provider APIs (deep approach A)

Through the WeldConnect connector framework (`connector_connections`; add
employee, pay-run and payslip entities to `ConnectorEntity`):

1. **Loket.nl**:
   - Write the period data ("variabele gegevens"), employments, wages and
     hours.
   - Read payroll results, payslips, year-end statements and journal runs.
   - Personio has used this integration since 2025.
2. **Nmbrs** (new REST API; SOAP retires in 2027): hours, wage components,
   salaries, contracts, leave.
3. **Easyflex** for staffing agencies, if the hours-import endpoint suffices.

### Phase 4: US embedded payroll on Check (approach B)

**Start condition:** signed US customers, and written answers from Check to
the questions in [us-providers.md](weldhr-payroll-research/us-providers.md) §3:
- Does Check contract with a non-US entity?
- Does it need a US bank account or EIN?
- What are the minimums?
- How are losses allocated at each payment speed?
- What does support cost?

**Build:**
- **Company onboarding** through Check components.
- **Sensitive employee data:**
  - SSN, W-4 and bank details are collected inside Check's components.
  - WeldSuite stores no US SSNs, which also keeps US tax identifiers out of
    an EU database.
- **Pay runs** built from phase 1 inputs, with status mirrored from webhooks.
- **Client sites** mapped to Check workplaces.
- **The journal** imported into WeldBooks.
- **Front-line support** stays with WeldSuite, and the provider's filing status
  is shown in our UI. In one Zoho review, the customer was not allowed to
  contact the hidden filing partner.

### Phase 5: Dutch own engine (approach C), behind a gate

**The gate:** an agreed number of Dutch employees on payroll prep (the plan's
rough arithmetic says thousands, not hundreds), or a design-partner customer
willing to run in parallel for a year.

**When the gate is met:**
1. Start the filing channel (3–4 months):
   - An ODB support subscription.
   - A PKIoverheid private-services server certificate.
   - A new Digipoort connection (the old one closes 1 December 2026).
   - Plan the certificate swap before G4 becomes mandatory in November 2028.
2. **Scope v1 to** ([nl-rules.md](weldhr-payroll-research/nl-rules.md) §10.4):
   - Employers without a CAO and with an insured (non-sector-fund) pension.
   - Monthly pay, resident employees, white table.
   - Director-shareholder (DGA) payroll.
   - Holiday pay, car, travel and WKR basics.
   - Corrections, payslip, jaaropgaaf, loonstaat.
   - pain.001 plus the Belastingdienst payment.
   - WeldBooks posting.
3. **Hire a Dutch payroll specialist** before the first line of engine code.
4. **Liability is contractual only.** The Belastingdienst always assesses the
   employer. Decide the indemnity cap. Nmbrs caps at 12 months of fees,
   maximum €100k, and excludes fines.
5. **Then one common CAO and sector pension fund at a time**, chosen by the
   customer base. Staffing stays on export.

## Data model sketch

New tenant tables (names indicative; each migration approved per PR):

| Area | Tables |
|---|---|
| Employment | `hr_compensations` (effective-dated pay), `hr_payroll_profiles` (per-country tax settings; encrypted ids), employee → `entities` link |
| Calendar | `hr_pay_schedules`, `hr_pay_periods` (with lock), `hr_public_holidays` |
| Inputs | `hr_pay_codes` (catalog per country), `hr_pay_inputs` (period, employee, code, quantity, amount, source, approval) |
| Runs | `hr_pay_runs` (period, status, source `export`/`provider`/`engine`, provider refs), `hr_payslips` (snapshot lines jsonb, YTD, R2 key) |
| Staffing | `hr_rate_cards`, `hr_rate_card_versions`, `hr_rate_card_lines`, `hr_timesheets`, `hr_timesheet_lines`, `hr_payable_charges`, `hr_billable_charges`, `hr_client_terms`, `hr_assignment_packages` |
| Providers | `provider`, `external_company_id`, `external_employee_id`, `external_payroll_id` on employer, employee and pay run |

Entity events for pay runs carry ids and status only. Amounts stay off the
bus, as WeldPass does for secrets.

## Pricing conventions

- **NL:** prices per payslip, e.g. €5–9 plus €25–40 per month at Employes, or
  about €3.70 per payslip inside Exact's €92.50 bundle.
- **US:** a monthly base plus a per-employee price, e.g. $39–50 plus $6–12 at
  Zoho, QuickBooks and Gusto.

([competitors.md](weldhr-payroll-research/competitors.md) §6.2)

- **Approach A:** a payroll-prep add-on per employee per month, priced well
  below the payslip price of the payroll it feeds.
- **Approach B:** resale over Check's wholesale price. The number is still
  needed.
- **Approach C:** the market price per payslip.

## Open questions for the owner

1. Agree the direction:
   - Phases 0–2 now.
   - Phase 3 next.
   - US B only after signed US customers.
   - NL C behind a demand gate.
2. Set the NL C gate: a number of employees on payroll prep, or a design
   partner.
3. Price the payroll-prep add-on.
4. Commercial calls, in parallel and without a build commitment:
   - **Check:** the written questions in us-providers §3.
   - **Gusto Embedded:** as comparison.
   - **Employes and Loket:** bureau or white-label terms.
   - **Remote:** only if multi-country customers appear.
5. Whether a payroll bureau on Loket or Nmbrs licences is worth running for
   early Dutch revenue.
6. Who owns phase 0's WeldBooks bridge (books-api entrypoint, payroll account
   roles, line dimensions), since it touches the WeldBooks US work in PR #1010.
