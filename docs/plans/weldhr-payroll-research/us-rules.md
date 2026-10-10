# US payroll rules, and what it takes for WeldSuite to run US payroll itself

Researched 8 October 2026. Sources are IRS, SSA, DOL, Treasury, state agency and vendor documentation, plus dated trade press. Where only a third party reports something, the text says so. This is product research, not legal or tax advice; the money-transmission and agent questions in sections 7 and 8 need US counsel before any build. Ledger impact of payroll, the ACH file format and 1099 reporting are already covered in [federal.md](../weldbooks-us-research/federal.md) (sections 5, 8 and 9) and are linked, not repeated. WeldHR's current tables are described in [codebase.md](codebase.md).

Context that shapes the conclusions: WeldSuite has no US legal entity and no plan for one, payroll is meant to be a per-employee revenue line, there is no concrete US demand yet, and the owner is willing in principle to carry legal responsibility for filings and payments.

## Summary

- **Approach C as a full-service provider (WeldSuite files and pays as the employer's agent) practically requires a US entity run by US persons.** IRS e-file rules require every Principal and Responsible Official on the application to be a US citizen or green-card holder (Pub 3112), and a Reporting Agent must be an e-file provider. A Dutch BV with Dutch directors cannot be a Reporting Agent. A CPEO needs a US location and a majority of US managers. Every money rail checked is limited to US businesses (Dwolla, Moov, Plaid Transfer), requires physical presence and a resident representative in the region (Stripe Treasury), asks for a US entity (Modern Treasury), or assumes the customer holds its own money transmitter licence (Stripe Global Payouts). An EIN is not the blocker: foreign entities can get one by phone, fax or mail.
- **A payments rail does not remove the US-entity need, and it only shifts the money-transmitter question.** If the rail (a bank or a licensed transmitter) holds funds in transit and the employer is the originator, WeldSuite may avoid holding funds, but the platform still onboards as a US business, still carries customers' negative balances (Plaid says so in its terms), and still has to fit each state's "agent of the payor" payroll exemption. Delaware (signed July 2026) and Maryland have such exemptions. The CSBS model act, by contrast, counts payroll processing as money transmission.
- **2026 is the first year OBBBA changes reach the W-2 in full.** Box 12 code TT (qualified overtime), TP (tips), TA (employer Trump-account contributions from 4 July 2026) and box 14b (tipped occupation code) are new. The 2025 penalty relief is over. Code TT is only the FLSA-required half of the time-and-a-half premium, computed per FLSA workweek, so the engine (or the export in approach A) needs FLSA status, workweek boundaries and the FLSA regular rate. CA daily overtime and double time beyond the FLSA minimum are excluded (IRS FS-2026-13).
- **Jurisdiction count is the real cost driver.** Symmetry's engine covers about 7,000 "taxing jurisdictions"; ADP markets filing in 11,000+. Each state also has its own withholding certificate, unemployment account and rate notice, and quarterly wage report. Thirteen states plus DC run payroll-funded disability or paid-leave programs in 2026 (Minnesota, Delaware and Maine benefits started this year); Maryland contributions start 1 January 2027. Local taxes (PA, OH, NYC/Yonkers, MI, KY, MD, IN, OR transit) depend on home and work address down to school district.
- **Tax engines only calculate.** Symmetry and Vertex return withholding and employer taxes; registrations, rate notices, deposits, returns, amendments, agency notices and money movement remain ours. Filing-and-deposit services exist (ADP SmartCompliance, BSI ComplianceFactory), but they bring us back to being, or depending on, a US agent. No engine publishes its price.
- **A "self-service" variant of C (software calculates and prints forms, employer deposits and files) avoids the agent, money-transmitter and US-entity problems but keeps most of the engineering cost.** The market is moving away from it: Wave moved all 50 states to full-service tax filing in April 2025, and QuickBooks Desktop Enhanced (self-file) sells at $1 to $3 per employee per month against roughly $6 per employee plus a base fee for full service.
- **For staffing and BPO agencies the hard parts are overtime across client assignments (one FLSA workweek per employer, not per client), work-site-based state and local tax, ACA measurement for variable-hour workers, and credit risk on payroll funding.** WeldHR records `company_id` on shifts and attendance, which helps, but has no structured work-site address, FLSA status, rate history or W-4 data.
- **Recommendation from the rules side:** for the US, ship A (payroll prep and export) first and design its data model so B (an embedded provider that is itself the agent and money mover) can be added when demand appears. Full C is not viable without a US subsidiary with US-person officers, money-transmission analysis in every state, a bank sponsor and SOC 1/SOC 2 audits; section 10 sizes it.

---

## 1. Federal withholding and employment taxes (2026)

### 1.1 Rates and bases

| Item | 2026 | Source |
|---|---|---|
| Social Security | 6.2% employee + 6.2% employer, wage base **$184,500** | Pub 15 (https://www.irs.gov/publications/p15) |
| Medicare | 1.45% + 1.45%, no wage base | Pub 15 |
| Additional Medicare | 0.9% employee only, withheld on wages above **$200,000** from the pay period the threshold is crossed; no employer share | Pub 15 |
| Supplemental wages (flat method) | **22%**; **37%** on supplemental wages above $1M in the year | Pub 15 |
| FUTA | 6.0% on the first **$7,000** per employee; credit up to 5.4% for state UI, so 0.6% net | Pub 15 |
| FUTA credit reduction (TY2025, paid with the 2025 Form 940) | California 1.2% (effective 1.8%), US Virgin Islands 4.5% | PayrollOrg (https://payroll.org/news-resources/news/news-detail/2025/11/11/california-virgin-islands-face-futa-credit-reduction-for-2025) |
| FUTA credit reduction (TY2026, potential) | CA 1.5%, possibly 5.3% with the benefit-cost-rate add-on; USVI 4.8%; final after 10 Nov 2026 | PayrollOrg (https://payroll.org/news-resources/news/news-detail/2026/04/07/california-and-virgin-islands-may-face-credit-reduction-for-2026) |
| Backup withholding (for contractors, see federal.md §5) | 24% | Pub 15 |
| Household employees / election workers FICA threshold | $3,000 / $2,500 | Pub 15 |

The credit reduction is computed on Schedule A (Form 940) per state where SUI was owed, and is paid with the fourth-quarter FUTA deposit. A multi-state employer has to track FUTA wages per state.

### 1.2 Pub 15-T: methods and Form W-4 versions

- Pub 15-T (2026) offers the **percentage method** (annual tables, usable for any pay frequency and for automated payroll) and the **wage-bracket method** (lookup tables per frequency, capped wage ranges). Automated systems use the annual percentage method. The 2026 tables "have been updated for changes made by P.L. 119-21" (OBBBA). (https://www.irs.gov/publications/p15t)
- 2026 annual percentage method, standard schedule (Step 2 box not checked), start of each bracket:

| Rate | Single / MFS: taxable amount at least | MFJ: taxable amount at least |
|---|---|---|
| 0% | $0 | $0 |
| 10% | $7,500 | $19,300 |
| 12% | $19,900 | $44,100 |
| 22% | $57,900 | $120,100 |
| 24% | $113,200 | $230,700 |
| 32% | $209,275 | $422,850 |
| 35% | $263,725 | $531,750 |
| 37% | $648,100 | $788,000 |

  Separate "Step 2 checked" schedules and a head-of-household schedule exist. (Pub 15-T, same URL)
- **Two W-4 regimes must both be supported.** A 2020-or-later W-4 carries filing status, the Step 2 multiple-jobs checkbox, Step 3 credits, Step 4(a) other income, 4(b) deductions and 4(c) extra withholding. A W-4 from 2019 or earlier (allowances) stays valid until the employee replaces it. Worksheet 1A handles it with $4,300 per allowance. A **computational bridge** lets an engine treat old forms as new ones: Single maps to "Single or MFS", Married to MFJ, Step 4(a) is $8,600 (Single/MFS) or $12,900 (MFJ), and Step 4(b) is allowances × $4,300. (Pub 15-T)
- The 2026 W-4 adds a checkbox below Step 4(c) to claim exemption, and Step 4(b) is where employees account for the new tips and overtime deductions. Employers may not cut withholding on their own because an employee expects the deduction. (Pub 15-T; IRS FS-2026-13 Q8 and Q9, https://www.irs.gov/pub/taxpros/fs-2026-13.pdf)
- **Nonresident aliens** get an amount added to wages before the table: $16,100 a year ($619.20 biweekly) for 2020+ forms, $11,800 for older ones. The add-on is not reported on the W-2. (Pub 15-T)

**Implication for WeldSuite:** the W-4 record must be versioned (form year, every step, exempt flag, effective date), and the engine must keep both the allowance and the 2020+ code paths. Both are mechanical once modelled. The cost sits in state certificates (section 3.2).

### 1.3 One Big Beautiful Bill Act (P.L. 119-21) effects on payroll in TY2026

- **Qualified overtime.** Employees may deduct up to $12,500 ($25,000 joint), phased out above $150,000 / $300,000 MAGI, for 2025 to 2028. The deduction is on the employee's return; the overtime stays subject to income tax withholding, FICA and FUTA. From TY2026 employers **must** report the full qualified amount (not capped) in **W-2 box 12, code TT**, and correct errors with a W-2c. (FS-2026-13 Q2, Q10, Q11; IR-2026-88, https://www.irs.gov/newsroom/irs-updates-faqs-on-qualified-overtime-deduction)
  - Qualified overtime is computed **per FLSA workweek**: hours over 40 × ½ × the FLSA regular rate. Only FLSA-required overtime counts. Overtime paid under state law (CA daily overtime), a union contract or company policy counts only to the extent the FLSA would have required it. Double time counts only up to the 1.5× premium. FLSA-exempt employees have none. (FS-2026-13 Q4, Q12, Q16)
  - The regular rate includes all remuneration except statutory exclusions (nondiscretionary bonuses, shift differentials, commissions), divided by hours actually worked. (FS-2026-13 Q15)
- **Qualified tips.** Deduction up to $25,000 for 2025 to 2028. TY2026 W-2 adds **box 12 code TP** ("Total amount of cash tips reported to the employer") and splits box 14 into **14a (other) and 14b (Treasury Tipped Occupation Code)**. (W-2/W-3 instructions 2026, https://www.irs.gov/instructions/iw2w3) Bloomberg Tax reports the final form allows up to two occupation codes per employee, with 000 for a non-qualifying job (third-party: https://news.bloombergtax.com/payroll/latest-2026-form-w-2-draft-allows-2-occupation-codes).
- **Trump accounts.** From 4 July 2026 employers may contribute up to $2,500 a year tax-free under a §128 program, reported as **box 12 code TA**. (Pub 15; W-2 instructions)
- **Dependent care assistance (§129)** exclusion rises from $5,000 to **$7,500** ($3,750 MFS) for tax years beginning after 2025. (https://www.law.cornell.edu/uscode/text/26/129)
- **W-2 threshold.** A W-2 is required for wages of **$2,000** or more when no income tax, Social Security or Medicare was withheld (was $600), indexed after 2026. (W-2 instructions)
- **Moving expense reimbursements** are now permanently taxable wages except for certain military and intelligence moves. (Pub 15)
- **2025 was a transition year.** Notice 2025-62 waived §6721/6722 penalties for not separately reporting tips, occupation or overtime on 2025 forms, if the forms were otherwise correct. That relief has ended. (EY summary: https://taxnews.ey.com/news/2025-2250-irs-provides-transitional-penalty-relief-for-reporting-2025-qualified-tips-and-overtime)

**Implication for WeldSuite:** code TT is the single biggest data-model consequence for every approach, A included. A provider can compute TT only from **workweek-level** hours, an FLSA exempt/non-exempt flag and every remuneration item that feeds the regular rate. WeldHR stores daily `worked_minutes` but no workweek definition, no FLSA status and no earning types. Staffing agencies make it harder: one person working for two clients of the same agency in one week has one FLSA workweek (FS-2026-13 Q13: a fixed, recurring 168-hour period, no averaging), so overtime is triggered across assignments and then has to be allocated back to client invoices.

### 1.4 Announced 2027 changes

- Social Security wage base 2027: not yet published on 8 October 2026. The Trustees' intermediate projection is **$190,200** (third-party: https://payroll.org/news-resources/news/news-detail/2026/06/09/social-security-trustees-project-wage-base-for-2027).
- New York PFL 2027: 0.452% employee rate, max $451.81 (third-party: https://www.nfp.com/insights/ny-announces-2027-paid-family-leave-limits/). Minnesota Paid Leave stays at 0.88% for 2027 (https://fox9.com/news/minnesota-paid-leave-premiums-wont-increase-2027). Maryland FAMLI contributions start 1 January 2027 (section 3.4). Michigan minimum wage rises to $15.00 on 1 January 2027 (https://www.dol.gov/agencies/whd/minimum-wage/state).
- ACA penalties 2027: one source reports Rev. Proc. 2026-22 sets $3,780 / $5,670 (single source, not verified: https://imacorp.com/insights/2027-employer-mandate-4980h-penalties).
- Information-return penalties rise for returns due after 31 December 2026 (W-2 instructions; amounts in federal.md §5).

## 2. Deposits and returns

### 2.1 Deposit schedule

- **Lookback period** for Form 941 filers: 1 July to 30 June. For 2026 it is 1 July 2024 to 30 June 2025. Reported tax of **$50,000 or less** makes the employer a monthly depositor; more makes it semiweekly. New employers are monthly depositors in their first calendar year. (Pub 15, §11)
- **Monthly**: by the 15th of the following month. **Semiweekly**: wages paid Wednesday to Friday are due the following Wednesday; Saturday to Tuesday, the following Friday. (https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-due-dates)
- **$100,000 next-day rule**: accumulating $100,000 or more of tax on any day requires deposit by the next business day, whatever the schedule. (Pub 15)
- **Under $2,500** for the quarter (and no next-day trigger): may be paid with the return instead of deposited. (Pub 15)
- All deposits must be made by **electronic funds transfer**: EFTPS, the business tax account or Direct Pay, or for a fee a bank-initiated ACH credit, a third party or a same-day wire. (https://www.irs.gov/businesses/small-businesses-self-employed/depositing-and-reporting-employment-taxes)
- FUTA: deposit when the quarterly liability exceeds $500, by the end of the month after the quarter; smaller amounts carry forward. (same page)

### 2.2 Returns

| Return | What | Due (TY2026) | Notes |
|---|---|---|---|
| Form 941 | Quarterly FIT, FICA, Additional Medicare | 30 Apr, 31 Jul, 2 Nov 2026 (31 Oct is a Saturday), 1 Feb 2027 | +10 days if all deposits were timely. Schedule B for semiweekly depositors. |
| Form 944 | Annual alternative | 1 Feb 2027 | Only for employers with ≤ $1,000 annual liability and written IRS notification. |
| Form 940 | FUTA, Schedule A for multi-state / credit reduction | 1 Feb 2027 | +10 days if FUTA fully deposited. |
| W-2 / W-3 | Employee copies and SSA Copy A | **1 Feb 2027** | E-file mandatory at 10+ information returns in aggregate. |
| 1094-C / 1095-C | ACA, large employers only | see 5.3 | |

Sources: employment tax due dates page above; Pub 15; W-2 instructions. Weekend shifts are computed from the calendar.

### 2.3 W-2 filing with SSA

- W-2s go to SSA, not the IRS (federal.md §5). **Business Services Online** allows up to 50 W-2s (or 25 W-2c) keyed online. Larger volumes are uploaded as an **EFW2** file; format specifications are at SSA.gov/employer/EFW2&EFW2C.htm. (W-2 instructions) The TY2026 EFW2 has to carry codes TP, TT, TA and box 14b; I could not open SSA's specification page to confirm the record positions (see Could not verify).
- A W-2c must be e-filed if the original was e-filed. The 2026 W-2c is Rev. 1-2026 and reflects the box 14 split. (W-2 instructions)

### 2.4 Corrections

- Prior-quarter errors go on **Form 941-X** (one per return corrected, filed separately, never with the original). Fractions of cents, third-party sick pay, tips and group-term life adjustments go on the current 941. Income tax withholding errors can be corrected on a 941-X only in the same calendar year, unless they are administrative errors. Interest-free correction is lost once the issue is raised in an IRS exam. (Pub 15, §13)
- Prior-year wage changes need a **W-2c/W-3c** to SSA. (Pub 15)

### 2.5 Penalties and personal liability

- **Failure to deposit**: 2% (1 to 5 days late), 5% (6 to 15 days), 10% (16+ days, or paid directly to the IRS or with the return), 15% (unpaid more than 10 days after the first notice). (Pub 15)
- **Trust fund recovery penalty**: 100% of unpaid withheld income tax and employee FICA, assessed personally on "responsible persons" who willfully fail to collect or pay it over. (Pub 15)
- Information-return penalties for late or incorrect W-2s: see federal.md §5.

**Implication for WeldSuite:** a full-service provider runs a deposit calendar per client (monthly or semiweekly, with the $100k trigger evaluated on every payroll run), and a single missed run creates a 2% to 10% penalty on the client's account plus personal exposure for its officers. This is the core of why full service is a liability business (section 8.4).

## 3. State and local

### 3.1 State income tax

- Nine states do not tax wages in 2026: **Alaska, Florida, Nevada, New Hampshire, South Dakota, Tennessee, Texas, Washington, Wyoming**. New Hampshire's interest and dividends tax ended for periods from 1 January 2025. (third-party: https://www.sofi.com/learn/content/states-with-no-income-tax/ ; https://www.nashuatelegraph.com/news/2025/01/25/repeal-of-nh-interest-and-dividends-tax-now-in-effect/) That leaves **41 states plus DC** with wage withholding.
- Washington has no wage tax but has payroll-funded PFML (section 3.4) and WA Cares long-term care contributions.

### 3.2 State withholding certificates

Most income-tax states publish their own certificate (for example California DE 4, New York IT-2104, Illinois IL-W-4); some use the federal W-4 as input. The certificate formats are not harmonised, and several changed after the 2020 federal redesign. Symmetry sells a separate product covering "over 130" withholding forms, which shows the scale (https://www.symmetry.com/symmetry-tax-engine). I did not build a per-state list (see Could not verify).

### 3.3 State unemployment insurance (SUI)

- Every employer registers with each state's UI agency where it has employees, gets an account number and an **experience rate** notice each year, and files **quarterly wage reports** (wages per employee) plus contributions. New employers get a statutory new-employer rate that varies by state and sometimes by industry. WeldSuite cannot calculate the rate; it has to store the rate notice per employer, per state, effective-dated.
- 2026 taxable wage bases range from the FUTA floor of **$7,000** (California, Florida) to **$78,200** (Washington). Examples: Alabama $8,000, Arizona $8,000, Georgia $9,500, New York $13,000, Delaware $14,500, Connecticut $27,000, Wyoming $33,800, Alaska $54,200. Twenty-eight jurisdictions index the base; Iowa, Louisiana, Missouri and Oklahoma lowered it for 2026. (EY: https://taxnews.ey.com/news/2026-0124-2026-state-unemployment-insurance-taxable-wage-bases ; WA: https://news.bgov.com/financial-accounting/washington-announces-2026-unemployment-taxable-wage-base) Colorado is reported as both $30,600 and $36,600; Hawaii's 2026 base was not confirmed.
- A few states also take employee UI contributions; Symmetry lists "employee SUI" as a distinct tax type.

### 3.4 State disability and paid family/medical leave programs

| Program | 2026 contribution | Status | Source |
|---|---|---|---|
| California SDI (incl. PFL) | 1.3% employee, **no wage cap** since 2024 | live | CalChamber (third-party): https://hrwatchdog.calchamber.com/2025/12/2026-social-security-taxable-wage-base-california-sdi-withholding-rate-increase/ |
| New York PFL (+ DBL) | 0.432% employee, max $411.91 | live | NFP (third-party): https://www.nfp.com/insights/ny-announces-2026-paid-family-leave-limits/ |
| New Jersey TDI / FLI | employee TDI 0.19%, FLI 0.23%; employer TDI 0.10% to 0.75% | live; wage base reported as $43,300 or $44,800 | NFP (third-party): https://www.nfp.com/insights/nj-announces-2026-disability-and-family-leave-contribution-rates/ |
| Washington PFML | 1.13% total, employee 71.43% of it; employers under 50 staff owe no employer share; capped at SS wage base | live | ESD: https://esd.wa.gov/node/1109 |
| Minnesota Paid Leave | 0.88% (0.61 medical + 0.27 family); employer may deduct up to half | **contributions and benefits from 1 Jan 2026** | DEED: https://mn.gov/deed/paidleave/employers/premiums/ |
| Maine PFML | up to 1%, split evenly; employers under 15 owe no employer share | contributions since Jan 2025, **benefits from 1 May 2026** | https://www.maine.gov/paidleave/ |
| Delaware Paid Leave | reported 0.8% split (third-party calculator) | contributions since Jan 2025, **benefits from 1 Jan 2026** | Blank Rome (third-party): https://blankrome.com/publications/paid-family-leave-coming-delaware |
| Maryland FAMLI | 0.9% split; employers under 15 owe no employer share | **contributions from 1 Jan 2027**, benefits January 2028 | NFP (third-party): https://www.nfp.com/insights/maryland-paid-family-and-medical-program-delayed/ ; state FAQ: https://paidleave.maryland.gov/employers/Documents/Contributions%20Frequently%20Asked%20Questions%20from%20Employers.pdf |
| Hawaii TDI, Rhode Island TDI/TCI, Massachusetts PFML, Connecticut PFML, Oregon Paid Leave, Colorado FAMLI, DC (employer-paid) | not re-verified for 2026 | live | |

Each program has its own wage base, employer-size rules, private-plan exemptions and filing portal, and most change their rate every year.

### 3.5 Local taxes

- Symmetry's list of local tax types gives the scope: city, county, school district, municipal, earned income, privilege, local services and JEDD/JEDZ taxes, plus courtesy withholding. Its engine picks the jurisdiction from **home and work addresses** via a location service. (https://www.symmetry.com/symmetry-tax-engine) Vertex's add-on assigns ZIP+4, political subdivision and, for **Pennsylvania and Ohio, school district** codes to "side-of-street" precision. (https://www.vertexinc.com/sites/default/files/2022-03/vertex-payroll-tax-data-sheet.pdf)
- **Pennsylvania**: every employer with a PA worksite (home-based employees included) withholds the local Earned Income Tax and the Local Services Tax, using PSD codes, and remits to the tax collection district. (https://dced.pa.gov/local-government/local-income-tax-information/)
- **Ohio**: municipal income taxes plus school district income taxes. **New York City and Yonkers**: resident taxes withheld with state tax (Yonkers also nonresident). **Michigan**: a set of cities, including Detroit, levy income tax. **Kentucky**: city and county occupational license taxes. **Maryland**: county income tax withheld together with state tax. **Indiana**: county tax by residence and work county. I could not re-verify the 2026 rates or counts for these (see Could not verify).
- **Oregon**: the statewide transit tax is 0.1% of wages of residents (wherever they work) and of nonresidents working in Oregon, withheld from the employee; Measure 120 failed in May 2026, so the rate is unchanged. TriMet and Lane transit taxes are separate employer-paid payroll taxes. (https://www.oregon.gov/dor/programs/businesses/Pages/Statewide-Transit-Tax.aspx) Portland-area Metro SHS and Multnomah PFA personal income taxes have employer withholding rules I could not confirm for 2026.

### 3.6 Reciprocity and multi-state work

A resident of one state working in another normally owes the work state, gets a credit at home, and the employer may need to withhold for both. Bilateral **reciprocity agreements** let the employer withhold only for the home state after the employee files a state-specific exemption certificate. Engines handle this ("multi-state calculations with reciprocity and nexus", Symmetry). Remote work adds "convenience of the employer" rules in a few states. For staffing agencies the work state is the client site, and it changes when the assignment changes.

### 3.7 How many jurisdictions

- Symmetry: "7,040 taxing jurisdictions and U.S. territories" on its product page, "over 7,000" elsewhere, and "7,400+" on third-party directories. (https://www.symmetry.com/symmetry-tax-engine)
- ADP: compliance "over 11,000 jurisdictions" for filing (vendor claim). (https://www.adp.com/what-we-offer/products/adp-smartcompliance/employment-tax.aspx)
- Practical floor for a national engine: federal (941/944, 940, W-2, 1094-C/1095-C and corrections), 41 states + DC withholding, 50 states + DC + territories UI, SDI/PFML programs in 13 states plus DC, thousands of locals.

**Implication for WeldSuite:** WeldHR's `hr_employees.location` is free text (`varchar(160)`) and the home address sits inside the encrypted blob as one string. Any approach that computes US tax, or exports enough for a provider to compute it, needs a structured, geocodable home address and work-site address per assignment (the CRM company record is not enough; one client can have several sites), each effective-dated. This is cheap to add and is needed for A as well.

## 4. Wage and hour rules payroll must compute

### 4.1 Federal minimum wage and overtime

- FLSA minimum wage is **$7.25**. Overtime is 1.5× the regular rate for hours over 40 in the workweek, for non-exempt employees. (https://www.dol.gov/agencies/whd/minimum-wage/state ; FS-2026-13 Q14)
- The regular rate includes nondiscretionary bonuses and other remuneration, so a quarterly production bonus forces an overtime **true-up** of past workweeks. (FS-2026-13 Q15; CA DIR: https://www.dir.ca.gov/dlse/faq_overtime.htm)
- The salary threshold for the white-collar exemptions could not be re-verified (see Could not verify).

### 4.2 State minimum wages (DOL table updated 1 July 2026)

Thirty states are above $7.25. Examples: Washington $17.13, Connecticut $16.94, California $16.90, New York $17.00 (NYC, Long Island, Westchester) / $16.00 (rest), New Jersey $15.92 ($15.23 small/seasonal), Oregon $15.55 standard / $16.80 Portland metro / $14.55 non-urban (adjusted every 1 July), Colorado $15.16, Arizona $15.15, Massachusetts and Illinois $15.00, Florida $14.00, DC $18.40. Five states have no minimum wage law; Georgia and Wyoming have $5.15 for non-FLSA employers. (https://www.dol.gov/agencies/whd/minimum-wage/state) Many cities and counties add their own minimum wages and different tipped-wage rules.

### 4.3 California daily overtime

1.5× for hours over 8 in a day and over 40 in a week; 2× over 12 in a day; on the seventh consecutive workday 1.5× for the first 8 hours and 2× after that. With two rates in a week the regular rate is a weighted average. (https://www.dir.ca.gov/dlse/faq_overtime.htm) A handful of other states have daily overtime (not re-verified).

### 4.4 Pay frequency and final pay

- California: at least twice a month on set paydays (wages for the 1st to 15th by the 26th; 16th to month-end by the 10th of the next month; other periods within seven days of period end). (https://www.dir.ca.gov/dlse/faq_paydays.htm)
- California final pay: **immediately** on discharge; on a quit, at the time of quitting with 72 hours' notice, otherwise within 72 hours. Willful late payment costs a day's wages per day, up to 30 days. (same page)
- Every state has its own pay-frequency and final-pay rule; the engine needs off-cycle runs and same-day termination checks.

### 4.5 Pay statements

California Labor Code 226 requires, among other things, gross and net wages, total hours (not for salaried exempt staff), deductions, pay period dates, the employer's legal name and address, and only the last four SSN digits or an employee ID. (https://www.dir.ca.gov/dlse/faq_paydays.htm) California also requires available paid sick leave on the stub or a same-day document. (https://www.dir.ca.gov/dlse/paid_sick_leave.htm) Other states have their own lists, and a few require access to a printable copy.

### 4.6 Paid sick leave

California: at least 1 hour per 30 hours worked, minimum 40 hours or 5 days a year since 2024, accrual may be capped at 80 hours or 10 days, use at 40 hours or 5 days. (https://www.dir.ca.gov/dlse/paid_sick_leave.htm) Most other states with mandatory paid sick leave use similar but not identical accrual rules, and several cities add their own. WeldHR's leave types and allowances would need accrual-per-hour-worked rules, caps and carryover per jurisdiction.

### 4.7 Garnishments

- Federal CCPA limits: for ordinary debts, the lesser of 25% of **disposable earnings** or the amount above 30× the federal minimum wage ($217.50 a week). Child support and alimony: up to 50% (supporting another family) or 60%, plus 5% if over 12 weeks in arrears. Federal tax levies, bankruptcy orders and state tax debts are outside these limits; federal non-tax debts (such as defaulted student loans) up to 15%. The cap applies to all garnishments together, and support orders take priority. Lower state limits win. (https://www.dol.gov/agencies/whd/fact-sheets/30-cppa)
- "Disposable earnings" are after legally required deductions only, so the engine needs every deduction tagged as mandatory or voluntary.
- Child support income withholding orders can be received and acknowledged electronically through the federal e-IWO program, and new hires must be reported to the state new hire registry (within 20 days under federal law, sooner in some states). I could not open the federal OCSS pages to re-verify these (see Could not verify).

**Implication for WeldSuite:** the wage-and-hour layer (workweek overtime, regular-rate true-ups, state and local minimum wage, sick-leave accrual, final-pay timing, pay-stub content) is needed in approaches A and B as well, because the hours WeldHR exports determine whether the provider pays correctly. A provider computes taxes; it usually does not decide which hours are overtime under California law if the input is "40 regular, 10 overtime".

## 5. Benefits and pre-tax deductions

### 5.1 2026 limits

| Item | 2026 | Source |
|---|---|---|
| 401(k)/403(b)/457(b) elective deferral | $24,500 | Notice 2025-67, via Vorys (third-party): https://www.vorys.com/publication-irs-releases-updated-retirement-plan-annual-limits-and-includes-unexpected-increase |
| Catch-up age 50+ | $8,000 | same |
| Catch-up age 60 to 63 | $11,250 | same |
| §415(c) total additions | $72,000 | same |
| Mandatory Roth catch-up | applies if 2025 FICA wages from the employer exceeded $150,000 | same |
| HSA self / family / 55+ catch-up | $4,400 / $8,750 / $1,000 | Rev. Proc. 2025-19, via Haynes Boone (third-party): https://www.haynesboone.com/news/blogs/irs-releases-2026-inflation-adjusted-amounts-for-hsas-and-hdhps |
| Health FSA salary reduction / carryover | $3,400 / $680 | Rev. Proc. 2025-32 (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf), via NIS (third-party): https://blog.nisbenefits.com/2026-health-fsa-limits |
| Dependent care FSA (§129) | $7,500 ($3,750 MFS) | https://www.law.cornell.edu/uscode/text/26/129 |

### 5.2 How deductions behave

- Each deduction type has its own treatment for FIT, FICA, FUTA, each state income tax, SDI/PFML and local tax. A Section 125 premium is generally pre-tax for FIT, FICA and FUTA; a traditional 401(k) deferral is pre-tax for FIT but still FICA wages; a Roth deferral is post-tax. States do not always follow federal treatment. This matrix is what engines like Symmetry sell as "pre-tax benefit rules, down to the local tax". (https://www.symmetry.com/symmetry-tax-engine)
- The mandatory Roth catch-up needs the prior-year FICA wages from the same employer, so the engine needs the prior year's W-2 data even for new customers that switched mid-history.
- Annual limits apply per person per calendar year, so a mid-year customer must import year-to-date amounts from the previous provider.

### 5.3 ACA employer reporting

- **Applicable large employers** (50 or more full-time employees including full-time equivalents in the prior year) file Forms **1094-C/1095-C** and are subject to the §4980H employer mandate.
- 2026: affordability threshold **9.96%** of household income (Rev. Proc. 2025-25, third-party: https://www.lcwlegal.com/news/new-aca-affordability-percentage-for-2026-is-9-96-percent/); penalties **$3,340** (§4980H(a), per full-time employee minus 30) and **$5,010** (§4980H(b), per subsidised employee) (Rev. Proc. 2025-26, KPMG: https://kpmg.com/us/en/taxnewsflash/news/2025/07/rev-proc-2025-26-indexing-adjustments-amounts-employer-shared-responsibility-payments.html).
- Under the Paperwork Burden Reduction Act (H.R. 3797, https://www.congress.gov/bill/118th-congress/house-bill/3797), employers may furnish 1095-C only on request, with a clear website notice; IRS filing is unchanged. 1095-C counts toward the 10-return e-file threshold.
- Staffing agencies with variable-hour workers need the look-back measurement method to decide who is full-time; this is hours-driven and fits WeldHR's attendance data.

## 6. Contractors

- The IRS uses the common-law control test (behavioural, financial, relationship); the DOL applies an FLSA "economic reality" test; several states (California's ABC test among them) are stricter. Misclassification creates back FICA, FUTA, SUI, overtime and penalties. I did not re-verify the current status of the DOL's 2024 independent contractor rule.
- Contractor payments are reported on 1099-NEC with the **$2,000** TY2026 threshold and 24% backup withholding; the full detail, including IRIS filing, is in [federal.md §5](../weldbooks-us-research/federal.md). federal.md §5 lists new 1099-NEC boxes 1b to 1d for tips, the tipped occupation code and qualified overtime, still to be confirmed on the final 2026 form.
- **Implication for WeldSuite:** contractors paid through payroll must not be counted twice in WeldBooks' own 1099 totals (federal.md §8). For staffing agencies, the W-2 versus 1099 choice is per worker and per assignment type, and should be an explicit field.

## 7. Moving money

### 7.1 What full-service payroll does with money

A typical provider debits the employer's bank for net pay plus all taxes a few days before payday, credits each employee by ACH (PPD with the mandatory "PAYROLL" entry description since 20 March 2026, see federal.md §9), holds the tax money until each deposit date, and pays EFTPS, state and local agencies, benefit carriers and garnishment payees. Between debit and remittance the provider holds the employer's money, sometimes for weeks (quarterly taxes). That holding period is what makes payroll a money-transmission question.

### 7.2 Federal (FinCEN)

- Whether a business is a money transmitter under the Bank Secrecy Act is "a matter of facts and circumstances". The payment-processor exemption requires, among other things, facilitating a **purchase or bill payment** under an agreement with the seller or creditor (FIN-2014-R009: https://www.fincen.gov/sites/default/files/administrative_ruling/FIN-2014-R009.pdf). Payroll money goes to employees and agencies, not to a seller, so the fit is uncertain. I found no FinCEN ruling specific to payroll processors.
- A **foreign-located** money services business doing business in the US must register with FinCEN and designate a US-resident agent for service of process (31 CFR 1022.380: https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1022/subpart-C/section-1022.380). So BSA status does not by itself require a US entity, but it adds a BSA/AML program, registration and US agent.

### 7.3 State money transmitter laws

- Money transmission is licensed state by state. The CSBS **Money Transmission Modernization Act** "expressly states that payroll processors are money transmitters" and imposes bonding and other requirements; before it, only four states (California, Ohio, North Carolina, Washington) addressed payroll processing, and they excluded it. States that adopted the model often left the payroll language out. (third-party: Troutman webinar transcript, https://www.troutman.com/wp-content/uploads/2024/07/Transcript_CFP_Navigating_New_Compliance_Challenges.pdf ; Asure, https://offers.asuresoftware.com/hubfs/Events/EVOLVE%202023/Evolve23%20-%20The%20True%20Impact%20of%20the%20Money%20Transmission%20Modernization%20Act.pdf)
- States are carving payroll back out on an **agent-of-the-payor** basis. Delaware's SB 18 (signed 6 July 2026, effective one year later or on final regulations) exempts a payroll processor if (1) a written agreement directs it to provide payroll services for the employer, (2) the employer holds it out to employees as its payroll provider, and (3) the employer's obligation to pay employees is **not extinguished** if the processor fails to deliver. (Delaware OSBC notice, 20 Aug 2026: https://banking.delaware.gov/wp-content/uploads/sites/73/2026/08/Payroll-Processor-Notice-Aug-21-2026.pdf) Maryland enacted a similar exemption effective 1 October 2026 (reported as HB 118 or SB 261), Nevada exempted payroll processing from 1 October 2025 (AB 430: https://archive.leg.state.nv.us/Session/83rd2025/Bills/AB/AB430_EN.pdf), Iowa has a limited exemption, and Michigan and Nebraska bills were pending in August 2026. (CSBS tracker: https://www.csbs.org/mtma-legislative-update-august-2026)
- California exempts wage delivery and payroll tax remittance under Financial Code 2010(j) but not other transmission services sold to the same customers (DFPI opinion: https://dfpi.ca.gov/rules-enforcement/laws-and-regulations/opinion-letters-by-law-subject/exemptions-for-agent-of-payee-and-payroll-processing-service/). Hawaii warns that payroll processors offering earned-wage access not funded by the employer may need a licence (https://cca.hawaii.gov/dfi24/files/2023/06/2023-0607-Payroll-Processors.pdf).
- The industry position (PayrollOrg, June 2025) is that payroll providers are payment processors, not transmitters (https://cms-prod.payroll.org/docs/default-source/2025-government-relations/25f03-Money-Transmitter-Letter.pdf). That is advocacy, not law.

### 7.4 Bank side: ODFI and Nacha third-party sender rules

- An ACH payroll provider originates through a US bank (the ODFI). A provider that originates for employers is a **Third-Party Sender**: the ODFI must register it with Nacha, and every third-party sender, nested ones included, must run its own ACH risk assessment and annual rules-compliance audit; relying on another party's audit is not enough. (https://www.nacha.org/rules/third-party-sender-registration ; https://www.nacha.org/rules/third-party-sender-roles-and-responsibilities)
- The 2026 Nacha fraud-monitoring rule applies to originators and third parties (federal.md §9).

### 7.5 Prefunding, debit risk and timing

- Gusto, as a reference: for a Friday payday the employer is debited Thursday (next-day), Wednesday (two-day) or the prior Monday (four-day). New employers start on four-day; two-day needs a 15-day wait and one successful debit; speed also depends on payment history. A failed debit adds fees. (https://support.gusto.com/article/186733245100000/processing-payroll-overview-for-admins ; https://docs.gusto.com/embedded-payroll/docs/processing-timelines)
- The risk is that the provider credits employees before the employer's debit is final. Rails hold debited funds for this reason: Moov 2 to 3 banking days "to account for the lag in time it takes to hear back about returns" (https://docs.moov.io/guides/money-movement/accept-payments/ach/ach-overview/), Plaid typically 2 to 5 business days after settlement, shorter with larger reserves, and consumer unauthorized returns can arrive up to 60 days later (https://plaid.com/docs/transfer/flow-of-funds).
- Standard ACH settles in one to two business days, Same Day ACH the same day, RTP and FedNow in seconds (https://www.moderntreasury.com/solutions/payroll). Prefunding by wire or RTP removes debit risk at the cost of customer friction.
- **Implication for WeldSuite:** staffing agencies pay workers weekly before their clients pay invoices, so they are the customers most likely to have thin balances on debit day. Whoever moves the money carries that credit risk.

### 7.6 Paying taxes electronically on someone's behalf

- **EFTPS Batch Provider** software is for payroll processors that enrol clients and send batches; it requires a Form 8655 or 8821 on file. **Bulk Provider** is the EDI route for high-volume processors, settled as consolidated debits or Fedwire. (third-party summary of IRS Pub 4169: https://cs.thomsonreuters.com/ua/acct_pr/acs/cs_us_en/pr/tax_processing/tp_proc/proc_eftps_overview.htm ; Pub 1474 points batch and bulk filers to Rev. Proc. 2012-33. Current limits: see Could not verify)
- Alternatively a bank can originate an **ACH credit in CCD+ format with a TXP addendum** (EIN in the identification field); the employer stays "ultimately responsible for timely payment", and many states accept the same TXP format with state-specific field rules. (EFTPS Financial Institution Handbook: https://fiscal.treasury.gov/files/eftps/Financial_Institution_Handbook.pdf)

### 7.7 Rails providers as a middle option

The question: can WeldSuite use a payments platform's rails so that the platform, not WeldSuite, holds and moves the money?

| Rail | Non-US platform? | Payroll allowed? | Originator / who holds funds | Debit hold vs payroll | Return / credit risk | Can pay EFTPS and states? |
|---|---|---|---|---|---|---|
| **Plaid Transfer** and **Transfer for Platforms** (beta) | Transfer is "US only", for "payers and recipients within the US"; onboarding asks for EIN/SSN, Secretary of State filings, control person ID; Custom plan, 12-month minimum. (https://plaid.com/docs/transfer/ ; https://plaid.com/docs/transfer/application/) | Not named. Platforms beta targets vertical SaaS bill collection and vendor payouts; "Payouts to individuals are not supported unless related to payment collection"; financial-services use cases excluded. (https://plaid.com/docs/transfer/platform-payments/) | End customers are onboarded as **originators** with their own Plaid Ledger; funds sit in Ledgers (Plaid's bank partners, not named). | 2 to 5 business days after settlement, shorter with reserves. | "You are liable for your customers' negative balances." | Not mentioned. |
| **Modern Treasury** (Payments, payroll solution) | Sign-up asks whether the company "has, or is creating, a U.S. registered legal entity". | Yes, marketed to payroll and HR software. | Platform originates the funding debit and worker credits through MT's bank partners or its own bank; "no need to open FBO accounts". | Debit ahead of payday, or wire/RTP funding. | ACH returns post to the funding order; allocation of loss not stated. | "Send tax payments from the same API"; "Tax agencies" payout type. Agency formats not described. (https://www.moderntreasury.com/solutions/payroll) |
| **Increase** | Not stated. Non-bank technology provider; accounts at partner banks (Increase Bank, Grasshopper, First Internet Bank). (https://www.increase.com/terms) | Not stated. | Customer is the account holder and originator at the partner bank. | Not checked. | Customer. | Bank-grade ACH origination, so CCD+ TXP is plausible but unconfirmed. |
| **Column** | Not stated; OCC-chartered national bank with its own Fed connection. (https://column.com/docs) | Not stated. | Bank holds funds; platform is the bank's program customer. | Not checked. | Program customer, per bank agreement. | As above, unconfirmed. |
| **Moov** | **No**: prohibited list includes "Businesses physically located outside of the U.S." (https://moov.io/legal/platform-agreement/prohibited-restricted-businesses/) | Payout guide names employees as recipients; payroll is used as the worked ACH example. (https://docs.moov.io/guides/use-cases/payouts) | All funds pass through Moov wallets; a third-party directory says Moov is the licensed transmitter (not in Moov's own docs). | 2 to 3 banking days, removable for approved accounts. | Platform/sender per agreement. | Not stated. |
| **Dwolla** | **No**: must "be a U.S. company ... with a U.S. physical address". (https://www.dwolla.com/legal/platform-agreement) | Not mentioned; personal, family or household transactions are excluded. | Funds held by Dwolla's financial institution partners. | Not checked. | Platform per agreement. | Not stated. |
| **Stripe** Treasury for platforms / Global Payouts / Connect | Treasury for platforms: US is **private preview**, B2B only, platform must "physically operate from, and have at least one account representative who lives at" an address in the region; third-party payment processors are restricted. (https://docs.stripe.com/treasury/connect/v2/requirements) Global Payouts: US and GB, NL in private preview, requires Treasury, and is "best for businesses that already hold the Money Transmitter License (MTL) required to move money themselves". (https://docs.stripe.com/global-payouts) | Not named for any of them; Global Payouts lists marketplaces, insurers, fintechs, creators. | Stripe and its bank partners hold balances. Connect pays out to connected accounts, which would mean onboarding each employee as a Stripe account. | Not checked. | Platform for its connected accounts. | Not stated. |

**Does a rail change the answer?**
- **US entity: no.** Dwolla and Moov exclude non-US businesses outright, Stripe requires physical operation and a resident representative in the region, Plaid Transfer is US-only and onboards with US identifiers, and Modern Treasury asks for a US entity. Even if a rail accepted a Dutch platform, the IRS agent roles in section 8 still require US persons.
- **Money transmitter: it can help, not decide.** The most defensible structure is the one the agent-of-payor exemptions describe: the **employer is the originator** (Plaid's model), a bank or licensed transmitter holds funds in transit, WeldSuite never has possession or control, the contract keeps the employer liable to employees, and WeldSuite is held out as the employer's payroll agent. Whether "instructing" a rail is itself transmission is state-specific; Stripe's own wording for Global Payouts assumes the customer holds an MTL. Counsel would need to map this per state.
- **Credit risk does not move.** Plaid makes the platform liable for negative balances, and the others leave it to the agreement. A WeldSuite on Plaid would underwrite US employers' payroll debits from the Netherlands.
- **Taxes are the gap.** Only Modern Treasury mentions tax payments. EFTPS batch payment on a client's behalf needs Form 8655/8821 authority (section 8), whichever rail moves the cash.

## 8. Acting as a payroll provider

### 8.1 Reporting Agent (Form 8655)

- A Reporting Agent is "an accounting service entity authorized by its client to prepare, sign and file Employment Tax Returns electronically"; Reporting Agents "are companies (not individuals) that perform payroll services for other businesses". (Pub 3112 Rev. 11-2025: https://www.irs.gov/pub/irs-pdf/p3112.pdf)
- Form 8655 authority covers signing and e-filing Forms 940, 941, 943, 944, 945 and their -X corrections, making deposits and payments for them, and receiving copies of notices (including W-2 and 1099 notices). The agent submits a Reporting Agent's List with the signed 8655s before or with its IRS e-file application, electronically via SLFT B2B above 100 clients a week. E-signatures on 8655 are allowed with identity proofing. (Pub 1474 Rev. 4-2026: https://www.irs.gov/pub/irs-pdf/p1474.pdf)
- The authorization "does not relieve the taxpayer of the responsibility" for timely filing and deposits, and the agent must tell each client so in writing at contract signing and **at least quarterly**. (Pub 1474 §01.01, citing Rev. Proc. 2012-32)
- **The citizenship test.** "Everyone who is a Principal or Responsible Official must: be a United States citizen or an alien lawfully admitted for permanent residence ...; be at least 18 ...; and meet applicable state and local licensing and/or bonding requirements." Principals of a corporation are its president, vice-president, secretary and treasurer (IRS guide, 2013: https://www.irs.gov/pub/irs-utl/IRS%20e-file%20Application%20Process%20ACA%20providers%2012-9-13.pdf); they are fingerprinted unless they hold professional credentials. The only escape is a "foreign EFIN" issued to a US provider for a firm in its business group, with the US provider responsible for that firm's compliance. (Pub 3112)
- Reporting Agent is the standard role for payroll service providers. The employer stays liable (section 8.4).

### 8.2 Section 3504 agent (Form 2678)

An employer can appoint an agent under §3504 with Form 2678; the agent files aggregate 941/940 with Schedule R. "All agents, employers, and payers remain liable for filing all returns and making all tax deposits and payments while this appointment is in effect." The instructions set no US-address rule for the agent. (https://www.irs.gov/instructions/i2678) It is used mainly for home-care and fiscal agents, not SMB payroll software.

### 8.3 PEO, CPEO and ASO

- A **PEO** co-employs the workers and reports under its own EIN; an **ASO** (administrative services) runs payroll and HR under the client's EIN, which is the Reporting Agent model.
- A **CPEO** (IRS-certified under §7705) takes over federal employment tax liability for covered wages. Certification requires being a business entity with "at least one physical business location within the United States", a majority of managers who are "U.S. citizens or residents", responsible-individual attestations and a CPEO application (https://www.irs.gov/tax-professionals/certified-professional-employer-organization). CPEOs must e-file 941, 943 and 940 with Schedule R. (Pub 15)
- Staffing agencies are already employers of record for their own workers, so PEO is not their model; their payroll is ordinary employer payroll at higher volume and with more locations.

### 8.4 Liability when the provider gets it wrong

- The employer is "ultimately responsible for the deposit and payment of federal tax liabilities", even when a provider was paid to deposit them, and the IRS can assess penalties and interest on the employer's account and personal liability on its officers. The IRS tells employers to enrol in EFTPS and check that deposits arrive, and not to change their address of record to the provider's. (https://www.irs.gov/businesses/small-businesses-self-employed/outsourcing-payroll-duties)
- Only a CPEO (for covered wages) shifts federal liability by law. Everyone else shifts it by contract: full-service providers sell "tax penalty guarantees" (QuickBooks Assisted: "Guaranteed on-time and accurate", subject to conditions: https://quickbooks.intuit.com/payroll/desktop/). A provider that misappropriates impounded taxes leaves the employer paying twice.
- **Implication for WeldSuite:** "taking legal responsibility" in the US means a contractual penalty guarantee plus errors-and-omissions and crime insurance, because the IRS will still pursue the employer first. The owner's willingness to accept liability does not change the IRS's eligibility rules in 8.1.

### 8.5 SOC 1 and SOC 2

Payroll affects every customer's financial statements, so auditors of larger customers ask for a **SOC 1 Type 2** report on the provider's controls over payroll processing; security-focused buyers ask for **SOC 2 Type 2**. Both are AICPA attestations issued by a licensed CPA firm, and a Type 2 report covers an observation period of several months, so the first one arrives well after launch (industry practice; the AICPA pages could not be fetched). Small employers rarely ask; staffing agencies with audited clients do.

### 8.6 What a foreign (non-US) company would need, and whether it forces a US entity

| Requirement | Can a Dutch BV do it directly? | Source |
|---|---|---|
| EIN for itself (as agent) | Yes: entities with a principal place of business outside the US apply by phone, fax or mail, not online. | https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number |
| IRS e-file application as Reporting Agent / transmitter / software developer | **Not with non-US officers**: all principals and responsible officials must be US citizens or green-card holders. | Pub 3112 |
| Form 8655 authority and Reporting Agent's List | Tied to the e-file application above. | Pub 1474 |
| EFTPS batch/bulk provider | Requires 8655/8821 on file; settlement from a US bank account. | EFTPS (7.6) |
| State withholding, UI and SDI agent access | Each state has its own third-party/agent registration and POA; not researched state by state. | Could not verify |
| Money transmitter licences or exemptions | Possible in principle for a foreign company, but each state's licensing needs bonds, audited financials and examinations; exemptions require the agent-of-payor structure. FinCEN registration needs a US agent. | 7.2, 7.3 |
| US bank account and ACH origination via an ODFI | Banks register providers as Third-Party Senders; the rails checked require or prefer a US entity. | 7.4, 7.7 |
| CPEO route | No: US location and majority US managers. | 8.3 |
| SOC 1 / SOC 2 | Yes; any company can be audited by a licensed CPA firm under AICPA standards. | 8.5 |

**Conclusion:** EIN, FinCEN registration and SOC audits do not force a US entity. The IRS e-file rule for Reporting Agents does force **US-person officers**, and banks and payment rails force a **US entity with a US address**. In practice full-service approach C means a US subsidiary with at least one US-citizen or green-card officer team, a US bank sponsor, and a state-by-state money-transmission position.

## 9. Tax engines

| Engine | What it does | What it leaves to us | Pricing |
|---|---|---|---|
| **Symmetry Tax Engine** (STE) | Federal, state, local withholding and employer taxes, PFML/SDI, employee SUI, courtesy withholding; ~7,000 jurisdictions; US, territories, Canada; reciprocity and nexus; pre-tax benefit rules; location service from home and work address; hosted Web API (AWS) or on-prem SDK (C/C++, Java, .NET, Delphi); monthly plus interim updates; stateless, stores no personal data. Sister products: Payroll Forms (130+ withholding forms), Minimum Wage Tracker, Payroll Point (lat/long lookup). (https://www.symmetry.com/symmetry-tax-engine) | Registrations, rate notices, deposits, returns, wage reports, W-2s, notices, money movement; wage-and-hour logic beyond the minimum-wage tracker. | Not published; free trial, quote on request. |
| **Vertex Payroll Tax** | US and Canada gross-to-net, gross-up, locals and reciprocity; jurisdiction code from city/state/county; optional address cleansing with PA/OH school district codes; multiple jurisdictions within a pay period; monthly content updates. GeoAlign sells the rates and formulas as data. (https://www.vertexinc.com/sites/default/files/2022-03/vertex-payroll-tax-data-sheet.pdf ; https://www.vertexinc.com/sites/default/files/2021-05/Vertex-Cloud-Payroll-Tax-DATA-SHEET.pdf) | Same as Symmetry. | Not published. Capterra lists "Vertex SMB" from $5,000 (product unclear: https://www.capterra.com.au/reviews/160387/vertex-smb); Vendr's median for Vertex indirect tax is ~$61k/yr, not payroll (https://www.vendr.com/marketplace/vertex). |
| **BSI TaxFactory** | The US payroll tax calculator inside SAP payroll; TaxLocator assigns jurisdictions; covers reciprocity, garnishments, pension distributions. Filing is a separate product, ComplianceFactory. (https://sapinsider.org/blogs/bsi-taxfactory-delivers-a-single-engine-for-u-s-payroll-tax-calculation/) | Filing unless ComplianceFactory is bought. | Not published. |
| **ADP SmartCompliance Employment Tax** (filing service) and **MasterTax** (in-house filing software, acquired by ADP) | Automated federal, state and most local filings and deposits, quarterly and annual reconciliation, amendments, notice handling, "even if you don't use ADP for payroll". (https://www.adp.com/what-we-offer/products/adp-smartcompliance/employment-tax.aspx ; https://www.accountingtoday.com/news/adp-acquires-mastertax) | Calculation (ours or an engine's), money collection from employers. | Not published. |

**Implication for WeldSuite:** an engine removes perhaps the most volatile content (rates, formulas, local boundaries), but it covers one of the four hard parts. Registration, deposits and filing, notices, and money movement remain, and the filing services that cover them make WeldSuite a customer of a US agent, which is approach B with extra steps.

## 10. What approach C would take, compared with a provider

### 10.1 Full-service C (WeldSuite is the agent and moves money)

Components, all required before the first US customer can be paid by WeldSuite:

1. **Legal**: US subsidiary; US-citizen or green-card officers for the IRS e-file application; state-by-state money-transmission analysis and either agent-of-payor structuring or licences (with surety bonds, net worth, audits and exams); FinCEN position; customer agreements with the Reporting Agent quarterly disclosure; E&O and crime insurance.
2. **Banking**: an ODFI relationship (Third-Party Sender registration, Nacha risk assessment and annual audit, fraud monitoring), FBO or impound accounts, EFTPS batch or bulk provider enrolment, ACH TXP for states, reserves or prefunding policy and credit underwriting.
3. **Engine**: licensed tax engine (Symmetry or Vertex) plus our own gross-to-net, W-4 and 40-plus state certificates, earnings and deduction taxability matrix, overtime and regular-rate logic, garnishments, YTD import, off-cycle and termination runs, retro pay.
4. **Filing**: 941/940/944 and -X through IRS MeF, Schedule B/R, W-2/W-2c via EFW2, 1094-C/1095-C, state withholding returns and reconciliations, SUI wage reports and SDI/PFML filings in every state served, local returns (PA, OH, ...), new hire reports, e-IWO.
5. **Operations**: per-client agency registrations and POAs, SUI rate notice capture, agency notice handling, amendments, year-end, a tax-penalty guarantee fund, SOC 1 and SOC 2 Type 2 audits every year.

My estimate (not sourced; for sizing only): one or two years before a multi-state launch, an engineering team in the high single digits, a payroll tax operations team that grows with clients and states, and fixed annual costs (engine licence, audits, insurance, bonds, banking and counsel) in the high six figures before revenue. The per-employee revenue to recover this is set by the market: QuickBooks Desktop Assisted at $2.50 per employee per pay period and Wave at $40 a month plus $6 per employee (https://quickbooks.intuit.com/payroll/desktop/ ; https://www.waveapps.com/payroll). Without a US entity, none of section 8 can start.

### 10.2 "Self-service" C (software calculates, employer deposits and files)

What it is: WeldSuite computes gross-to-net, produces pay stubs, filled 941/940/W-2 and state forms and a Nacha file; the employer pays employees from its own bank (uploading the Nacha file, as originator under its own ODFI agreement) or by check, deposits taxes itself through EFTPS and state portals, and uploads W-2s to SSA BSO itself.

Products that still work this way in 2026:
- **QuickBooks Desktop Enhanced Payroll**: "you file and pay taxes"; included with Enterprise Gold and Platinum; $3 per employee per month for 1 to 9 employees, falling to $0 above 220; direct deposit is offered as part of the service, which puts the vendor back in the money flow. Assisted (Intuit files) is Enterprise Diamond only. (https://quickbooks.intuit.com/payroll/desktop/)
- **Halfpricesoft ezPaycheck**: desktop (Windows/Mac) with 2026 federal and state tables, prints 941/940/W-2; e-filing and Nacha direct deposit are separate products. (https://www.halfpricesoft.com/payroll_software_download.asp)
- **Payroll4Free**: free for 9 or fewer employees, ad-funded, tax calculations, direct deposit or checks. (https://www.payroll4free.com/)
- **Patriot Software Basic Payroll** is commonly cited as the self-file tier next to its Full Service tier; its site blocked fetching, so price and terms are not verified.
- Market signal: **Wave** dropped its self-service states and moved tax filing to "all 50 US states" for customers from 2 April 2025, at $40 base plus $6 per employee. (https://www.waveapps.com/payroll)

What it avoids and what it keeps:
- **Avoids** money transmission (WeldSuite never holds or instructs funds, if it only produces files; offering its own direct deposit would bring section 7 back), the Reporting Agent role and its US-person rule, EFTPS provider enrolment, CPEO, bank sponsorship and most of the liability.
- **Keeps** the whole calculation and forms burden (section 9 engine plus our own state certificates, wage-hour and garnishment logic), annual form and EFW2 updates, and contractual liability for calculation errors.
- **E-filing gap**: IRS MeF e-file of 94x by the software requires an IRS e-file application (software developer or transmitter), and Pub 3112 states the citizenship rule for the application as a whole, so it appears to apply to those roles too. Without a US-person team, WeldSuite would produce PDFs for paper filing or rely on a third-party transmitter; W-2s go through the employer's own BSO account.
- **Acceptance**: I could not find data on the share of SMBs willing to deposit and file their own payroll taxes; the direction of Wave and the bundling of QuickBooks Enhanced into its top desktop tiers suggest a shrinking, low-price segment. It fits neither target customer well: SMBs who want payroll to be "done", and staffing agencies whose volume and multi-state exposure make self-filing risky.

### 10.3 Comparison for the US

| | A. Prep and export | B. Embedded provider | C-lite self-service | C full-service |
|---|---|---|---|---|
| US entity | No | Depends on provider's partner terms (not researched here) | No | **Yes**, with US-person officers |
| Money transmission | No | Provider's problem | No | Yes, state by state |
| Engine and forms | No | Provider | Yes | Yes |
| Filing and deposits | No | Provider | Employer | WeldSuite |
| Liability | Data accuracy only | Provider (WeldSuite for its inputs) | Calculation errors | Penalties, guarantees, trust-fund exposure |
| Revenue per employee | Low | Revenue share | Low ($1 to $3 market) | Highest ($6+ market) |
| Data WeldHR needs | Workweek hours, FLSA status, earning types, structured addresses, work sites per assignment, rate history | Same | Same plus W-4 and state certificates, deductions, YTD | Same as C-lite |

**Implication for WeldSuite:** the data-model work in the last row is shared by every option and is where the US rules bite first. Building it for A keeps B and C open. Full C should not be on the table without a decision to open a US company.

---

## Could not verify

My web search budget ran out partway through (a shared limit), so the following were not checked against a primary source:

1. **FLSA white-collar salary threshold** for 2026 (believed to be $684 a week after the 2024 rule was vacated; the DOL page returned 403).
2. **Pub 15 rule that a monthly depositor who hits the $100,000 next-day rule becomes semiweekly** for the rest of the year and the next year.
3. **1094-C/1095-C 2027 filing dates** and the exact Paperwork Burden Reduction Act furnishing rule (sources disagree on "later of 31 January or 30 days after request").
4. **EFW2 TY2026 record positions** for codes TP, TT, TA and box 14b (SSA page returned 403); whether BSO accepts them in early 2027.
5. **New hire reporting deadline (20 days) and e-IWO** details; the OCSS pages returned 403.
6. **State withholding certificates**: which states use their own form versus the federal W-4, and which changed for 2026.
7. **SUI**: Hawaii's 2026 wage base; Colorado ($30,600 vs $36,600); new-employer rates per state; which states take employee UI contributions.
8. **SDI/PFML**: 2026 rates for Hawaii, Rhode Island, Massachusetts, Connecticut, Oregon, Colorado and DC; New York DBL; New Jersey's wage base ($43,300 vs $44,800); Delaware's 0.8% (third-party only); Maryland benefits start (1 or 3 January 2028); WA Cares rate.
9. **Local taxes**: 2026 rates and counts for PA EIT/LST (and the $52 LST cap), Ohio municipalities and school districts, Michigan cities, Kentucky, Maryland counties, Indiana counties, NYC/Yonkers; Metro SHS and Multnomah PFA withholding rules for 2026.
10. **Reciprocity agreements**: the current list of state pairs.
11. **Paid sick leave**: number of states and cities with mandates in 2026; states other than California with daily overtime.
12. **State taxation of pre-tax deductions** (for example Pennsylvania's treatment of 401(k) deferrals).
13. **DOL independent contractor rule** status in 2026.
14. **2027 ACA penalty amounts** ($3,780 / $5,670, single source) and the 2027 affordability percentage.
15. **EFTPS Batch/Bulk Provider limits** (sources give 750, 1,000 or 5,000 per transmission).
16. **Money transmission**: whether Maryland's payroll exemption is HB 118 or SB 261 and its final text; outcomes of the Michigan, Nebraska and Minnesota bills; whether any FinCEN ruling addresses payroll processors directly.
17. **Rails**: Increase's and Column's eligibility for non-US companies; whether any rail supports CCD+ TXP tax payments; Moov's licence list; Plaid Transfer's position on payroll.
18. **Embedded providers' partner terms** (Gusto Embedded, Check and others): whether a non-US platform can resell them, which decides whether approach B needs a US entity.
19. **Patriot Software** Basic vs Full Service pricing and terms (site blocked); share of SMBs using self-filed payroll.
20. **State payroll-agent registrations**: which states require a third-party payroll provider to register, bond or file a POA per client.
21. **Social Security wage base 2027**: expected mid-October 2026; $190,200 is a projection.
