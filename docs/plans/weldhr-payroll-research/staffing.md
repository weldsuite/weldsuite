# Staffing and BPO payroll in the Netherlands and the US: what it means for WeldHR

Researched 8 October 2026. Sources are vendor API docs and help centres, Dutch branch bodies (ABU, SNA, Wijzerbelonen, SETU), Belastingdienst, the Wtta portal, US federal regulations (eCFR via Cornell LII), IRS and state statutes. Third-party claims (law firms, payroll blogs, staffing agencies' own explainers) are marked "(third party)". The web-search budget ran out partway through the US section, so several US items rest on fewer sources than the Dutch ones; see "Could not verify". This file covers what is specific to staffing and BPO. General NL and US payroll law, providers and competitors are covered elsewhere in this folder. `codebase.md` maps what exists in WeldSuite today.

## Summary

- **Most of what a staffing agency needs is the pay/bill layer, not payroll.** Rate cards, timesheets with client approval, turning hours into pay lines and bill lines, consolidated client invoices, and margin reporting all sit upstream of gross-to-net. Bullhorn, Avionté and TempWorks treat this layer as the core of the product. WeldHR has to build it under A, B or C, and it can ship before payroll does.
- **Pay and bill are two separate rule sets on the same hours.** Bullhorn keeps separate pay and bill rulesets at client, job and placement level, and rate-card lines with separate pay and bill multipliers per earn code. Overtime can be paid without being billed, and fees can be billed without being paid. One "rate" column on `hr_client_assignments` is not enough.
- **NL: the brief's "inlenersbeloning" was replaced on 1 January 2026.** The CAO voor Uitzendkrachten 2026–2028 (ABU and NBBU) now requires *gelijkwaardige beloning*: the total value of the temp's package must at least equal that of a comparable employee of the client, tested on essential terms and on the whole package. The client supplies its terms through a standard SETU web form that saves as JSON. The Wet meer zekerheid flexwerkers puts the same principle into law for all agencies from 31 December 2026 at the earliest.
- **Gelijkwaardige beloning does not force an own engine, but it rules out generic payroll.** Deciding the package is a per-assignment data problem that WeldHR can own: store the client's terms, compare, record what the worker was told. Paying it needs a payroll that accepts per-assignment, per-hour pay components plus the uitzend-specific items: phases, StiPP, the SFU levy, sector 52 and pension-compensation allowances. In NL that means a staffing payroll package (Easyflex, Mysolution, AFAS Flex and others) or approach C. We found no embedded NL payroll API that advertises uitzend support.
- **NL invoices need a G-rekening split.** A client that hires from an SNA-certified agency and pays 25% of the invoice including VAT (20% when VAT is reverse-charged) into the agency's blocked G-rekening is protected from inlenersaansprakelijkheid for the agency's payroll taxes and VAT. Agency invoices must state that amount, and WeldBooks must book and reconcile receipts that land in two bank accounts.
- **NL Wtta dates are now firm.** Agencies register for the transition scheme from 1 November to 31 December 2026. The law takes effect 1 January 2027, applications run 1 May to 30 June 2027, and the public register opens 1 July 2027. Enforcement starts 1 January 2028; from then clients may only hire from admitted agencies.
- **US: approach B fits staffing well.** Check models a "workplace" per earning line, so one pay run can tax hours worked in several states. Everee sets pay rates, workers' comp codes and work locations per shift or assignment, and pays daily. The parts the provider does not do are ours anyway: overtime across assignments (the FLSA counts all of a week's assignments together) and how to bill it, workers' comp class per assignment, and ACA hours tracking.
- **BPO is mostly ordinary payroll plus different billing.** BPO staff are usually salaried employees billed per FTE, seat or output, often with KPI-linked credits. The payroll is SMB payroll. The work is in recurring and usage-based invoicing from WeldHR data, which WeldHR's KPI tables already partly hold. In NL, outsourcing escapes uitzend rules only if the BPO itself directs the work.

---

## 1. How staffing software models pay and bill

### 1.1 Placement, rates and markup

- **Placement is the contract.** In Bullhorn the Placement record carries `payRate` ("Rate at which the employee will be paid during regular business hours"), `clientBillRate`, `overtimeRate`, `clientOvertimeRate`, and `markUpPercentage`, defined as `(clientBillRate - payRate) / payRate`. It also carries the billing wiring: `billingClientContact`, `approvingClientContact` ("ClientContact who can approve the timecard"), `billingFrequency`, `costCenter` ("Drives invoice grouping"), `invoiceGroupName`, `billingProfile`, `statementClientContact` and `shift`. (https://bullhorn.github.io/rest-api-docs/entityref.html)
- **Rate cards are layered and effective-dated.** Bullhorn has `ClientCorporationRateAgreementCard` (client level), `JobOrderRateCard` (order or role level) and `PlacementRateCard` (assignment level). Each has versions with `effectiveDate` and `effectiveEndDate`, groups lines per earn-code group, and has lines with `payRate`, `billRate`, `payMultiplier`, `billMultiplier`, `markupPercent`, `markupValue`, `earnCode` and `taxableMargin`. Earn codes are typed Regular, Overtime or Double time and grouped so a base rate drives its OT and DT rates through multipliers. (same source)
- **Pay rules and bill rules are separate objects.** `ClientCorporationPayRuleset` and `ClientCorporationBillRuleset` exist, along with job-order and placement versions of both. Each holds `timeLaborEvalRules`, and there is a holiday calendar. The same hours can therefore be classified one way for pay (state overtime law) and another for billing (the client contract). (same source)
- **Markup vs. margin.** Markup is (bill − pay) / pay. Gross margin is (bill − pay − burden) / bill, where burden is the employer cost on top of gross pay. Avionté generates bill rates from a markup percentage or derives the markup from a typed bill rate, and uses markup templates so a pay-rate change cannot quietly erode the margin (third party: a staffing firm's Avionté setup guide, https://scribehow.com/viewer/How_to_Open_an_Order_in_Avionte__lAozAckzRK-WsjLhXix8HQ).
- **Dutch practice prices with a factor.** The usual NL quote is *tarief = bruto uurloon × omrekenfactor*. The factor covers reserveringen (holiday pay, holidays, short absence), employer premiums, StiPP pension and the margin. Reported 2026 ranges are about 1.9–2.6 for uitzenden and 2.0–3.0 for detachering (third party, https://recruitmenttraining.pro/nieuws/kosten-uitzendkracht-omrekenfactor/). AFAS Profit's flex module shows the margin effect of a deviating price agreement while you enter it (third party summary of https://help.afas.nl).

### 1.2 Time, expenses and approval

- **Timesheet per placement per period.** Bullhorn `Timesheet` has `hoursWorked`, `units`, `billed` ("Amount to be billed") and `paid` ("Amount to be paid") side by side, with day-level `TimesheetEntry` rows and an approval status. `ExpenseSheet`/`ExpenseSheetEntry` carry separate `billed` and `paid` amounts per expense line with an earn code and unit of measure. Per diems are an expense or earn code that may be paid, billed, both or neither. (https://bullhorn.github.io/rest-api-docs/entityref.html)
- **Customer-required fields.** Large clients require extra codes on each timesheet (project, GL, PO line). Bullhorn models this as `CustomerRequiredFieldMeta` with an `isRequiredOnTimesheet` flag. (same source)
- **Invoice terms gate billing on approval.** `InvoiceTerm` has `purchaseOrderRequired`, `waitForTimecards`, `invoiceOn`, `payBillCycle`, `surchargeRates` and `discountRates`, and its version has `invoiceApprovedTimecardsRequired`. (same source)
- **NL electronic timesheets.** The SETU standards (Stichting Elektronische Transacties Uitzendbranche) define Timecard v1.4, Assignment v1.4.1, StaffingOrder, HumanResource and a SETU Invoice v2.2 built on NLCIUS. They have run over Peppol since June 2024. The client approves the timecard, and "approved timecards form the basis for automatic invoicing". When an agency subcontracts, it usually rewrites rates and references before forwarding the timecard. (https://prod.econnect.eu/en/docs/learn/document-formats/formats/setu)

### 1.3 Invoicing, credit and funding

- **Consolidated invoices.** Bullhorn's `ClientCorporation.billingFrequency` takes weekly, bi-weekly, semi-monthly or monthly. `invoiceFormat` tells the back office how to group invoices. `InvoiceStatementLineItem` has `groupBys` and `summarizeBys`, so one invoice can cover many placements, grouped by PO, cost centre or worker. Discounts and surcharges are effective-dated rate objects applied per earn code. (https://bullhorn.github.io/rest-api-docs/entityref.html) AFAS Flex collects billable lines per client, cost centre or department, per week, 4 weeks or month. Corrections go out as a netted correction invoice or as a credit plus rebill. (https://help.afas.nl/help/NL/SE/Pro_Config_Flx_Inv.htm)
- **Corrections are new transactions, not edits.** Bullhorn charge transactions carry an `adjustmentSequenceNumber` and reversal links, so a late timesheet fix produces a reversal and a new charge on the next invoice. (same Bullhorn source)
- **Payroll funding.** Weekly payroll runs ahead of 30–60 day client terms, so agencies borrow against receivables. TempWorks sells a payroll-funding service alongside its software (https://www.tempworks.com/case_study/payroll-processing). Factoring usually requires the invoice to carry the funder's remit-to details and an assignment notice (general industry practice, not re-verified).
- **Credit limits.** Agencies check client exposure, meaning unbilled approved hours plus open invoices, against a limit before accepting more orders. We found no vendor documentation for this. WeldSuite already stores `parties.creditLimit`, `paymentTerms` and `outstandingBalance` (`packages/core/db/src/schema/parties.ts:87-95`).

### 1.4 Vendors at a glance

| Product | Market | Payroll | Notes |
|---|---|---|---|
| Bullhorn | US, UK, global | Native Pay & Bill data model (PayMaster, PayCheck, StateTaxForm, DirectDepositAccount entities) | Rate cards, rulesets, invoice terms, VMS-style discounts (https://bullhorn.github.io/rest-api-docs/entityref.html) |
| Avionté BOLD | US | In-house, "automates tax calculations and filings across multiple states and localities" | Back office sold standalone since 2024. Reports ~800 agencies and over 4 million W-2s in 2023 (https://www.avionte.com/payroll/ ; https://www.avionte.com/news/avionte-introduces-standalone-back-office-solution-for-enterprise-staffing-agencies/) |
| TempWorks Enterprise | US | Payroll, tax management, ACA administration, optional full-service tax filing and payroll funding | (https://www.tempworks.com/case_study/payroll-processing) |
| Everee | US | Embedded payroll for staffing: W-2 and 1099 in one run, same-day ACH and instant paycards, multi-state by shift location | APIs and embeddable UI (https://www.everee.com/staffing) |
| Easyflex | NL | Payroll, invoicing, planning; "bijna 1.500 uitzendbureaus" | Integrates with CAO-data vendors (https://www.easyflex.nl/) |
| Mysolution | NL, DE | Payroll, CAO surcharges, invoicing, worker portal on Salesforce + Business Central | (https://www.mysolution.com/en/backoffice) |
| AFAS Profit Flex | NL | Payroll with phase counting, flex invoicing | (https://help.afas.nl/help/NL/SE/Pay_Flx_Fase.htm) |

Wijzerbelonen's list of CAO-data vendors also names HelloFlex, Byner, Tigris, NoCore, Pivoton and A Perfect Match as staffing back offices with integrations (https://www.wijzerbelonen.nl/tooling-van-cao-gespecialiseerde-marktpartijen/).

### 1.5 Staffing vs. BPO

Staffing bills hours: bill rate × approved hours per earn code, weekly or 4-weekly, with the client approving. BPO and outsourcing contracts usually bill per FTE per month, per seat, per handled transaction or call, or a fixed fee with SLA credits. The agency's own staff are typically salaried and work in its delivery centre (general industry practice; we found no vendor documentation). Bullhorn's earn codes carry a `unitOfMeasure` and timesheets carry `units`, so unit-based billing fits the same charge model. Legally the difference matters in NL: if the client directs the work, "outsourcing" is uitzenden (see 2.1).

**Implication for WeldSuite:** the pay/bill layer (rate cards, timesheets, charges, invoices, margin) does not depend on A, B or C and should be designed first. Model rates as effective-dated rate-card lines per earn code with separate pay and bill values, not as columns on the assignment. Model timesheet lines as two charge streams, payable and billable, so they can diverge.

## 2. Netherlands

### 2.1 Uitzenden, detachering, payrolling, outsourcing

| Form | Who employs and who directs | Key rules |
|---|---|---|
| Uitzenden (art. 7:690 BW) | Agency employs; client (inlener) directs | Uitzendbeding (contract ends when the client ends the placement) is allowed for 26 weeks by law, extended to 52 weeks by the uitzend-CAO (third party, https://www.grantthornton.nl/insights/themas/belastingadvies/wat-is-een-uitzendovereenkomst/) |
| Detachering | Agency employs, usually on an ordinary fixed or permanent contract; client directs | Not a separate legal category. If the client directs the work it is uitzenden in law (third party, same source) |
| Payrolling (art. 7:692 BW, art. 8a Waadi) | Payroll company employs; the client recruited the worker; no allocation function; placed exclusively with one client | Since 1 January 2020 the worker gets the same terms as the client's own employees, and an adequate pension since 2021. The client must hand over its terms before the start (third party, https://www.salarisvanmorgen.nl/2019/10/11/wab-payrollkrachten-krijgen-dezelfde-arbeidsvoorwaarden/) |
| Outsourcing / aanneming van werk | Contractor employs and directs its own staff, at its own risk | Not inlening. If the client directs in practice, it is disguised uitzenden (third party, https://www.rendement.nl/uitzendkrachten-gedetacheerden/verdiepingsartikel/alles-wat-u-moet-weten-over-detachering-en-contracting.html) |

Since 2020, agencies fall in premium sector 52 (uitzendbedrijven) and payroll companies in sector 45 (third party, https://www.salarisvanmorgen.nl/2019/11/01/uitzendwerkgevers-in-sector-52-vanaf-2020/). An uitzendovereenkomst with uitzendbeding pays the high WW (AWf) rate, 7.74% in 2026 against 2.74% (third party, https://www.salarisvanmorgen.nl/2025/09/16/premiepercentages-sociale-verzekeringen-2026-awf-premie-aof-premie-en-meer/).

**Implication for WeldSuite:** each assignment needs an engagement type (`uitzenden`, `detachering`, `payrolling`, `outsourcing`, `direct`), because it decides the CAO, the equal-pay regime, the WW rate, inlener liability and invoice content. A BPO customer that sets "outsourcing" while its client directs the team is taking a legal risk, so the setting should be visible and auditable.

### 2.2 The CAO voor Uitzendkrachten 2026–2028

- **Term and status.** The CAO runs from 1 January 2026 to 31 December 2028. ABU filed the request to make it generally binding (AVV) with SZW in early June 2026 and has answered objections. The ABU page does not say AVV has been granted. (https://www.abu.nl/cao/) The CAO binds ABU and NBBU members. Non-members must give equal pay under the law and case law (third party, https://www.rendement.nl/uitzendkrachten-gedetacheerden/verdiepingsartikel/wijzigingen-door-nieuwe-cao-voor-uitzendkrachten-per-2026.html). CNV says the deal was signed with the small union LBV, without FNV, CNV or De Unie (third party, https://www.cnv.nl/dienstverlening/uitzendbureaus/cao-abu-uitzendkrachten/nieuws/).
- **Phases.** ABU fase A, B, C equal NBBU fase 1-2, 3, 4, with the same rights. For workers hired after 3 January 2022: fase A runs 52 worked weeks with the uitzendbeding possible, and a week counts if at least one hour was worked. Fase B allows at most 3 years and 6 contracts without uitzendbeding. Fase C is an indefinite contract. An interruption of 26 weeks or more restarts the count at fase A. AFAS raises a review task about 8 weeks before a phase change. (https://help.afas.nl/help/NL/SE/Pay_Flx_Fase.htm) We could not confirm from the CAO text whether the 2026 CAO shortens fase B from 2027 (see "Could not verify").
- **Sector fund.** The separate CAO-SFU (Sociaal Fonds voor de Uitzendbranche) runs 1 January 2026 to 1 January 2027, between ABU, NBBU, VvDN and LBV. It levies a percentage of the uitzend wage bill that funds SNCU, the body that enforces the CAO, and Doorzaam, which funds training. It applies when the uitzend wage bill is at least 50% of the agency's total wage bill. (https://www.abu.nl/app/uploads/2026/01/SFU-cao-01-01-2026.pdf) We did not find the 2026 percentage.

### 2.3 From inlenersbeloning to gelijkwaardige beloning

- **What changed.** Until 2025 the agency asked the client for a fixed list of about ten pay elements: scale wage, periodieken, initial raises, allowances for overtime, shifts and irregular hours, ADV, expense allowances, the year-end bonus and so on. It then copied them one-to-one (third party, https://www.salarisvanmorgen.nl/2026/01/09/nieuwe-cao-voor-uitzendkrachten-per-2026-gelijkwaardige-arbeidsvoorwaarden/). Since 1 January 2026 the temp is entitled to an equivalent package. Art. 21(2) names the essential terms: pay and other allowances, working hours including overtime, rest and breaks, night work, holiday length and work on public holidays. Art. 21(3) covers everything else. Both the essentials together and the whole package must be at least equivalent. A shortfall in an essential term cannot be offset by a non-essential one, though the reverse is allowed. (third party law firm, https://www.loyensloeff.com/nl/insights/news--events/news/belangrijke-veranderingen-ten-aanzien-van-de-beloning-van-uitzendkrachten-in-nederland-per-1-januari-2026/)
- **The four-step process** is: ask the client for the terms of a comparable permanent employee, receive them, set the equivalent package, and confirm it in writing to the temp. (https://www.wijzerbelonen.nl/) The client must supply all terms, "from vacation days and a thirteenth month to budgets for solar panels or gym memberships", and pass on changes straight away. Doing this properly limits the client's chain liability for wages. (https://www.wijzerbelonen.nl/ik-ben-opdrachtgever-wat-betekent-het-voor-mij/) The client is jointly and severally liable for the wages under art. 7:616a BW (Loyens, above).
- **Three ways to build the package:** mirror all of the client's terms; match the amounts and percentages (toekenningen) but meet entitlements (aanspraken) with the agency's own schemes; or use the agency's standard package plus a project allowance for the gap. (https://www.wijzerbelonen.nl/hoe-kom-je-tot-een-gelijkwaardig-pakket/)
- **Machine-readable input exists.** SETU built a web form for the standard request. Its saved output is "een JSON-bestand" whose fields follow a SETU standard, alongside a PDF version updated March 2026 (https://www.wijzerbelonen.nl/standaard-uitvraag-formulier/). SETU calls the new message "UGB" (https://www.setu.nl/). CAO-data vendors sell the client-CAO side: Inlenersbeloning.com (70+ CAOs, Easyflex integration), Caoloon.com (about 200 sector CAOs, Mysolution, Byner and Tigris integrations) and CAOWijzer (1,300+ CAOs, from €99 to €449 per month). (https://www.wijzerbelonen.nl/tooling-van-cao-gespecialiseerde-marktpartijen/)
- **Pension compensation is a pay component.** Pension is non-essential. If the client's employer premium is higher than StiPP's 15.9%, the agency pays the difference. Method 1 is the difference in premium percentage × the StiPP pension base. Method 2 compares average premiums over a reference period. The value may be multiplied by 0.853 if paid as pensionable pay. "Pension cannot be compensated with pension", so it is usually a gross allowance paid with every wage payment. (https://www.wijzerbelonen.nl/pensioencompensatie-en-de-gelijkwaardige-beloning/)

**Implication for WeldSuite:** gelijkwaardige beloning is a per-assignment data and decision problem upstream of payroll. WeldHR can own it under any approach:
- store the client's terms per client and job, versioned, imported from the SETU JSON;
- store the chosen package and the comparison behind it;
- record the confirmation sent to the worker in the employee portal;
- output pay components (hourly wage, allowance percentages, pension compensation, reserveringen) that the payroll consumes.

It also changes the bill side, because the bill rate is usually factor × the resulting wage. A client-CAO wage increase is therefore a rate-card version change for both pay and bill.

### 2.4 Pension and premiums

Since 1 January 2026 StiPP runs a single scheme for temps aged 18 and over, replacing the Basis and Plus schemes (https://www.abu.nl/cao/ ; https://www.wijzerbelonen.nl/pensioencompensatie-en-de-gelijkwaardige-beloning/ for the 15.9% employer premium). A third party reports a total premium of 23.4% of the pension base, 15.9% employer and 7.5% employee, with no waiting period (https://recruitmenttraining.pro/nieuws/kosten-uitzendkracht-omrekenfactor/).

### 2.5 Waadi registration and the Wtta

- **Waadi.** Every business that places workers, including payroll and secondment firms, must be registered as such in the KVK Handelsregister. Clients should check this with the KVK Waadi-check before hiring, and both sides can be fined. (https://ondernemersplein.overheid.nl/personeel/inhuren/personeel-inhuren-en-uitlenen-waadi-registratie-en-waadi-check/)
- **Wtta timeline** (https://www.toelatinguitleenmarkt.nl/):
  - 1 November to 31 December 2026: register for the transition scheme.
  - 1 January 2027: the law takes effect.
  - 1 May to 30 June 2027: apply for admission (toelating) or an exemption.
  - From 1 July 2027: the NAU assesses applications and the public register opens.
  - From 1 January 2028: the Arbeidsinspectie enforces, and clients may only hire from admitted or exempt agencies.
- **SNA shortcut.** An agency that holds the SNA keurmerk (module TBA) on 30 June 2027 does not have to submit an inspection report once. SNA says the legal admission "does not automatically replace" the wider scope of its keurmerk and will keep offering it. (https://www.normeringarbeid.nl/nieuws/tijdpad-toelatingsplicht-wat-betekent-dit-voor-sna-gecertificeerde-ondernemingen) Advisers report a €100,000 guarantee deposit per legal entity and a VOG for legal entities as conditions (third party; see "Could not verify").

### 2.6 Inlenersaansprakelijkheid, ketenaansprakelijkheid and the G-rekening

- **Liability.** The client can be held liable for the agency's unpaid payroll taxes and VAT on the hired workers. A sub-lender can be held liable as well, and liability runs along the whole chain. The client limits its exposure with a *verklaring betalingsgedrag* (payment-behaviour statement), by meeting its record-keeping duties, and by paying the tax part of each invoice into the agency's G-rekening. (https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/aangifte_betalen_en_toezicht/aansprakelijkheid/inlenersaansprakelijkheid/inlenersaansprakelijkheid)
- **G-rekening.** A blocked bank account at a bank where the agency also holds a current account. The client deposits "het geschatte bedrag aan loonheffingen en/of btw" (the estimated payroll taxes and/or VAT). The agency can only use the balance to pay its own payroll taxes and VAT to the Belastingdienst, and can ask to release a surplus, which takes about 2 weeks. (https://www.belastingdienst.nl/wps/wcm/connect/nl/betalenenontvangen/content/g-rekening)
- **SNA vrijwaring (indemnity) at a fixed percentage.** If the agency holds the SNA keurmerk, the client is indemnified when it pays 25% of the invoice including VAT into the G-rekening, or 20% when VAT is reverse-charged. The client must also keep records that link contract, hours (manurenadministratie) and payments, and must be able to prove the worker's identity and right to work. The indemnity fails if a non-certified lender sits in the chain, and does not cover ketenaansprakelijkheid for aanneming van werk. (https://www.normeringarbeid.nl/faq)
- **Wage chain liability is civil.** Separately from tax, temps can claim unpaid wages from the client under art. 7:616a BW (Loyens, above).

**Implication for WeldSuite:** an NL agency invoice from WeldBooks needs:
- a per-client G-rekening percentage (25%, 20% for reverse charge, or a custom estimate);
- the G-rekening IBAN and the amount to pay into it, printed on the invoice and carried in the e-invoice;
- matching of two receipts, one into the normal account and one into the G-rekening, against one invoice;
- the G-rekening as its own bank account and ledger account that only pays the Belastingdienst.

The client portal is also the natural place to share the agency's SNA certificate, Waadi registration, verklaring betalingsgedrag and later the Wtta admission. Approved timesheets double as the client's manurenadministratie and should be exportable for it.

### 2.7 Wet meer zekerheid flexwerkers

The Eerste Kamer passed the law on 7 July 2026 and it was published on 15 July 2026 (https://www.eerstekamer.nl/verslagdeel/20260707/wet_meer_zekerheid_flexwerkers ; third party, https://www.salarisvanmorgen.nl/2026/07/07/wet-meer-zekerheid-flexwerkers-per-1-januari-2028-een-feit/).
- **From 31 December 2026:** agency workers get at least equivalent terms by law, through the Waadi. This covers all terms, not only pay, and applies to non-member agencies too.
- **From 1 January 2028:** the rest of the law applies.
  - Ketenregeling: after three fixed-term contracts, a three-year gap is needed.
  - Zero-hour contracts are replaced by contracts with a minimum and maximum hours band, the maximum at most 30% above the minimum.
  - The most uncertain phases of agency work are shortened.

**Implication for WeldSuite:** phase lengths, chain rules and contract types change in 2027–2028. Phase counting must be data-driven and effective-dated, not hard-coded to 52 weeks.

### 2.8 How Dutch agencies run payroll today

Agencies mostly run payroll inside an integrated staffing back office that bundles placements, phase counting, CAO surcharges, StiPP and SFU, loonaangifte and invoicing: Easyflex, Mysolution, AFAS Profit Flex, HelloFlex, Byner, Tigris, NoCore, Pivoton. They buy client-CAO data from specialised vendors (sources in 1.4 and 2.3). Small agencies also outsource the back office to a payroll bureau or administratiekantoor (general practice, not quantified). Hours and invoices flow over SETU, with Peppol as transport.

**Implication for WeldSuite:** NL approach A for staffing means exporting approved hours, earn codes, assignment ids and per-assignment pay components to one of these packages, ideally as SETU Timecard/Assignment messages. Those packages also invoice, so we must decide per customer which system invoices the client. Doing it in both double-bills.

## 3. United States

### 3.1 Employer of record, pay frequency and daily pay

- **The agency is the employer.** The IRS example: a staffing service that hires the workers, controls their pay, can discharge or reassign them, and provides unemployment insurance "is the employer for employment tax purposes" (https://www.irs.gov/pub/irs-pdf/p15a_13.pdf, an older edition of Pub. 15-A; current edition https://www.irs.gov/publications/p15a).
- **Weekly pay.** Weekly pay is the norm for temps and is legally required in some cases. New York requires manual workers to be paid "weekly and not later than seven calendar days after the end of the week" (https://www.nysenate.gov/legislation/laws/LAB/191). Staffing scale: about 2.2 million temp and contract workers in an average 2024 week, 12.7 million hired in 2023 (https://americanstaffing.net/research/fact-sheets-analysis-staffing-industry-trends/staffing-industry-statistics/).
- **Daily pay.** Everee runs payroll once shifts are verified and pays by same-day ACH or instant paycard (https://www.everee.com/staffing). TempWorks lists pay-card providers as a partner category (https://www.tempworks.com/case_study/payroll-processing). We did not verify the current federal and state rules for earned-wage access.

### 3.2 Overtime across assignments, and who pays for it

The FLSA requires the employer to "total all the hours worked by the employee for him in that workweek (even though two or more unrelated job assignments may have been performed)" (https://www.law.cornell.edu/cfr/text/29/778.103). With different rates in one week, the regular rate is the weighted average (https://www.law.cornell.edu/cfr/text/29/778.115). A temp who works 25 hours at client X and 25 at client Y earns 10 overtime hours that neither client's contract triggers. The agency then chooses whether to absorb them, bill them to the client whose hours crossed 40, or split them pro rata. That choice belongs to the bill ruleset, which is why Bullhorn keeps bill rules separate from pay rules (1.1).

### 3.3 Where the work is done: state and local tax, workers' comp, SUI

- **Withholding follows the worksite.** Check taxes earnings "based on the location where work occurs". An employee can have several workplaces, and each earning line on a payroll can name its own workplace. State unemployment, however, is driven by the employee's primary workplace. (https://docs.checkhq.com/docs/workplaces) Everee applies state and local rules "based on where each shift was worked" (https://www.everee.com/staffing). Reciprocity and resident-state rules are general US payroll and covered elsewhere.
- **Workers' comp class codes sit on the assignment.** Everee sets "pay rates, workers' comp codes, and work locations ... at the shift or assignment level" (https://www.everee.com/staffing). In one firm's Avionté setup every order needs a WC code tied to the job, a new worksite must be reported to the WC administrator, and internal office staff use code 8810 (third party, https://scribehow.com/viewer/How_to_Open_an_Order_in_Avionte__lAozAckzRK-WsjLhXix8HQ). WC premium is charged on payroll per class code and state (general practice), so the class code drives burden and therefore the minimum markup. The insurer's year-end audit needs payroll by state and class code, which WeldHR can produce from payable charges.
- **SUI experience rating.** Staffing firms carry high turnover and therefore high benefit charges and experience-rated SUI rates. Several states have temp-specific rules on refusing reassignment (general practice; state specifics not verified). The SUI rate is an input to burden and margin.

### 3.4 ACA for variable-hour temps

- **Staffing-specific definition.** An employee hired "for temporary placement at an unrelated entity" is assessed as variable-hour using factors such as whether temps can reject placements, have gaps without offers, get placements of differing length, and "typically are offered temporary placements that do not extend beyond 13 weeks" (https://www.law.cornell.edu/cfr/text/26/54.4980H-1, ¶(a)(49)(ii)(B)). No single factor decides, and commentators read the test as applying per position, not per firm (third party, https://www.mintz.com/sites/default/files/viewpoints/orig/5/2014/03/WDC1_GENERAL-1148450-v1-TMM-Article-22414-BianchiLenz.pdf).
- **Look-back method.** Hours in a measurement period fix full-time status for a following stability period. 130 hours in a month equals 30 hours a week. (https://www.law.cornell.edu/cfr/text/26/54.4980H-3)
- **Coverage offered for a client.** When the agency is not the common-law employer, its coverage offer counts as the client's only if the client pays a higher fee for workers who enroll (https://www.law.cornell.edu/cfr/text/26/54.4980H-4).

**Implication for WeldSuite:** hours of service must be tracked per employee per month across all assignments, kept even after an assignment ends, with measurement and stability periods per employee. Payroll providers do not necessarily do this. TempWorks sells ACA administration as a separate module (https://www.tempworks.com/case_study/payroll-processing).

### 3.5 Joint employment, PEO and ASO

- **Joint employment.** Wage-and-hour, labor-relations and ACA liability can attach to both agency and client. The ACA rule above is one concrete case. We could not verify the 2026 status of the DOL and NLRB joint-employer standards.
- **PEO and ASO.** A PEO co-employs a client's own workforce and runs payroll under its arrangement. The IRS certifies PEOs voluntarily as CPEOs (https://www.irs.gov/tax-professionals/certified-professional-employer-organization). An ASO provides administration without co-employment (general definition). A small agency or BPO can also use a PEO for its own staff. For WeldHR, a customer on a PEO is close to approach A: WeldHR supplies hours and rates, and the PEO pays.

### 3.6 Who runs US staffing payroll

The incumbents (Avionté, TempWorks, Bullhorn) run payroll inside the staffing suite, as in the table in 1.4. The embedded options are Everee, which is staffing-focused (W-2 and 1099, daily pay, multi-state per shift), and Check, an API with per-earning workplaces. We could not confirm which outside payroll partners Bullhorn uses in the US.

**Implication for WeldSuite:** in the US, approach B with a staffing-aware provider covers gross-to-net, filing, multi-state withholding and daily pay. WeldHR must still send each earning line with its worksite and WC code, and must own overtime allocation for billing, ACA hours and margin.

## 4. What this means for WeldHR's data model and features

These apply under A, B and C. Table references are to `packages/core/db/src/schema/weldhr.ts` unless noted. `codebase.md` lists the general payroll gaps; this section adds the staffing layer.

### 4.1 `hr_client_assignments` becomes the pay/bill contract (`weldhr.ts:183`)

The table has `employeeId`, `companyId`, `role`, `allocationPercent`, `isPrimary`, start and end dates, and is end-dated, never deleted. That history model is right for placements. Add:
- **Engagement and employer:** `engagementType` (2.1) and `employerEntityId`, the WeldBooks accounting entity that employs and invoices. Large agencies run separate legal entities.
- **Billing wiring:**
  - `billingContactPersonId`;
  - one or more timesheet approvers (CRM people, matching `hr_portal_access.personId`);
  - `poNumber`, `costCenter`, `invoiceGroupKey`;
  - a `billingProfileId` (frequency, grouping, G-rekening percentage, payment terms) defaulting from the client.
- **Worksite:** a structured address separate from the CRM company address. US tax and WC follow the worksite (3.3), and one client can have several sites.
- **NL fields:** `caoCode`, `phase`, and a link to the gelijkwaardige-beloning package (4.6).
- **US fields:** `wcClassCode`, `wcState`, `flsaClassification`.
- **Rates:** a `rateCardId`. Rates belong in versioned rate-card lines, not on the assignment row.

`allocationPercent` stays as a planning figure. It is not a billing quantity.

### 4.2 Rate cards (new)

- **`hr_rate_cards`** with scope `client` (company), `client_role` (company + role or job code) and `assignment`. A lower scope overrides a higher one, as Bullhorn's client → job order → placement chain does.
- **`hr_rate_card_versions`** with `effectiveFrom` and `effectiveTo`.
- **`hr_rate_card_lines`** with:
  - `earnCode`: regular, ot_150, ot_200, night, weekend, holiday, on_call, travel_time, per_diem, mileage, or a unit code for BPO;
  - `unit`: hour, day, shift, km, FTE-month, seat-month or transaction;
  - `payRate` or `payMultiplier` of the base line;
  - `billRate`, `billMultiplier`, `markupPercent` or `factor`;
  - `billable` and `payable` flags.

Store how the bill rate is derived (fixed, markup on pay, NL factor on wage, or fixed margin) so a wage change recomputes the bill rate correctly. A client-CAO wage step is a new version, not an edit, so past invoices stay reproducible.

### 4.3 Timesheets and client approval in the existing portal

- **Build timesheets from attendance.** `hr_attendance_records` (`weldhr.ts:278`) already has `companyId`, `shiftId`, `workedMinutes`, `status`, `source` and `approvedBy`/`approvedAt`, and `hr_shifts` (`weldhr.ts:263`) has `companyId`. Add `hr_timesheets`, one per employee, assignment and workweek, with status `draft → submitted → client_approved | rejected → locked → invoiced / paid`. Add `hr_timesheet_lines` for classified hours per day and earn code, plus expenses.
- **Lock what is approved.** Today editing attendance clears approval (`codebase.md`). Once a timesheet is approved or invoiced, its attendance must lock, and corrections become adjustment lines on a later period. Bullhorn and AFAS both work this way (1.3).
- **Client portal.** The client side of `public-hr-portal` today offers `/client/overview`, `/client/team/:employeeId` and `/client/requests` (`apps/workers/hr-api/src/routes/public-hr-portal/index.ts:550-640`). Add `GET /client/timesheets` and `POST /client/timesheets/:id/approve|reject`. Limit them to `hr_portal_access` rows of kind `client` that are named approvers on the assignment. Record approver, time and IP in `hr_audit_events`. Add a portal setting for auto-approval after N days (cf. Bullhorn `waitForTimecards`), and decide whether the client sees pay or only bill amounts. The default should be bill amounts and hours only.
- **Customer-required fields** per client, such as project code or PO line, required at approval.
- **SETU.** Export approved timecards as SETU Timecard and import the client terms JSON (2.3). Peppol transport can follow later.

### 4.4 Time classification and the two charge streams

A rules step turns timesheet lines into:
- **`hr_payable_charges`**: employee, assignment, earn code, quantity, pay rate, worksite, WC code. This feeds the export (A) or the provider (B).
- **`hr_billable_charges`**: company, assignment, invoice group, earn code, quantity, bill rate. This feeds WeldBooks.

The pay rules follow the law: US weekly overtime across assignments (3.2) and state daily overtime; NL CAO surcharges and the client's terms. The bill rules follow the contract. Keeping them apart supports non-billable overtime, billable fees (placement, background check, VMS discount) and the US overtime-allocation choice. NL reserveringen (holiday pay, holiday hours) accrue on the payable side per hour worked.

### 4.5 Client invoicing through WeldBooks

- **Generate invoices from billable charges.** A periodic job groups charges per client, `invoiceGroupKey` or PO, and billing period, and creates `invoices` + `invoice_items` (`packages/core/db/src/schema/accounting-invoices.ts`). Items can use the existing `period` (l.119) for the week, and the description names worker, earn code and dates. `invoices.reference` (l.48) can hold the PO for a single-PO invoice; multi-PO invoices need a PO per line. Each billable charge stores its `invoiceItemId` so nothing is billed twice.
- **Credit check** against `parties.creditLimit` and `outstandingBalance`, plus unbilled approved hours, before releasing new shifts (1.3).
- **Factoring:** a remit-to override and assignment text per client billing profile.
- **E-invoicing:** NL clients increasingly expect SETU Invoice or Peppol UBL (1.2).

### 4.6 NL compliance records

- **Phase counter** per employee per agency entity: worked weeks (any hour counts), current phase, phase-B contracts and calendar weeks, last worked date for the 26-week reset, and a reminder before a phase change (AFAS model, 2.2). The thresholds must be effective-dated rules (2.7).
- **Gelijkwaardige beloning:**
  - `hr_client_terms`, per company and job, versioned, from the SETU JSON, with a source document;
  - `hr_assignment_packages`, the chosen package and its comparison, with essential and total tests;
  - the worker confirmation, delivered through the employee portal;
  - output pay components, including pension compensation.
- **G-rekening:** a `bank_accounts` kind `g_account` (the table has no type field today), a per-client percentage on the billing profile, a split amount printed on the invoice, and two-account receipt matching.
- **Agency compliance documents** (Waadi, SNA, verklaring betalingsgedrag, Wtta admission) with expiry dates, shown to clients in the portal (2.6).

### 4.7 US records

- Worksite and WC code per assignment, with an override per shift.
- A workweek definition per employer entity.
- ACA hours-of-service ledger and measurement periods per employee (3.4).
- Pay schedule per employee: weekly by default, daily optional.

### 4.8 Margin reporting

Gross margin per assignment, client, recruiter and period = billed − (gross pay + burden). Burden comes in two stages:
- **Estimate.** Use a burden profile per country, entity and client. In NL that covers employer premiums, StiPP 15.9%, the SFU levy, reserveringen and WW at the high rate. In the US it covers FICA, FUTA, the SUI rate, the WC rate for the class code and benefits. This lets margin show as soon as hours are approved.
- **Actuals.** Under A or B the real employer cost only arrives after payroll, so import the payroll journal per employee and period and allocate it to assignments by payable charge. Show estimated vs. actual.

Markup is the measure sales negotiates with. Margin is the measure management steers on. Show both.

### 4.9 BPO billing

For per-FTE, per-seat or per-output contracts, use the same rate-card lines with units `fte_month`, `seat_month` or `transaction`. Quantities come from active assignments (FTE), seat counts, or `hr_kpi_values` with `companyId` (`weldhr.ts:434`) for output. SLA credits are negative billable charges computed from KPI results against targets. `recurring_invoices` in WeldBooks can carry the fixed part. Payroll for BPO staff is ordinary salaried payroll.

## 5. What A, B and C can do for staffing

| Capability | A: prep + export | B: embedded provider | C: own engine |
|---|---|---|---|
| Rate cards, timesheets, client approval, invoicing, margin estimate | WeldHR, same in all three | WeldHR | WeldHR |
| US weekly or daily pay, multi-state per earning, filing | Provider or PEO does it from our export | Good fit (Check workplaces per earning; Everee per-shift location, WC code, daily pay) | Large: every state and locality |
| US overtime across assignments | WeldHR must compute it for billing anyway; pay side by provider or ours | Same | Ours |
| US ACA variable-hour tracking | WeldHR (hours ledger) | WeldHR, unless the provider offers it | WeldHR |
| NL gelijkwaardige beloning decision | WeldHR (data + comparison), exported as components | WeldHR, if the provider accepts per-assignment components | WeldHR |
| NL uitzend payroll (phases, StiPP, SFU, sector 52, high WW, reserveringen, per-placement components) | Only to a staffing payroll package (Easyflex, Mysolution, AFAS Flex and others) or a bureau using one | Only if a provider supports the uitzend CAO via API. We found none | Must implement the uitzend CAO, StiPP and SFU on top of general NL payroll |
| NL G-rekening invoices, Waadi/Wtta/SNA records | WeldBooks + WeldHR | Same | Same |
| BPO salaried payroll | Any | Any | Any |

Conclusions:
- **US staffing works with B.** The provider choice should require per-earning worksite, a WC code per line or the ability to report by it, weekly and daily pay schedules, and import of employer-cost results for margin. Nothing staffing-specific forces C in the US.
- **NL staffing payroll is a specialised niche.** Gelijkwaardige beloning (formerly inlenersbeloning) does not itself force C: the decision can live in WeldHR and pass as pay components. But the payroll that consumes those components must be an uitzend payroll. With no embedded NL provider for that, the realistic options are A (export to the agency's staffing package, with a clear rule on who invoices) or C. Building C means taking on the uitzend CAO, StiPP, SFU, phase rules and the 2027–2028 law changes, in a market where Easyflex alone serves about 1,500 agencies.
- **BPO customers in both countries need only general payroll plus the billing layer.** The legal check that NL outsourcing really is aanneming van werk is a data flag, not a payroll feature.
- **Build order that holds under any approach:** rate cards → timesheets with client approval → charges → WeldBooks invoices (with NL G-rekening) → margin with estimated burden → NL client-terms and phase tracking. Payroll export or a provider then consumes the payable charges.

## Could not verify

- **ABU CAO text itself.** We did not read the 2026–2028 PDF. Phase lengths come from AFAS help (as applied to workers hired after 3 January 2022). The claims that fase B shortens from 3 to 2 years and the break between contracts lengthens to 5 years from 2027 come from an agency blog (https://www.intropersoneel.nl/blog/wat-heb-ik-als-flexkracht-aan-de-nieuwe-cao-voor-uitzendkrachten-2026/). Art. 21 wording comes from Loyens & Loeff. Whether AVV has been granted is not stated on abu.nl.
- **NBBU 2026 CAO text** (assumed identical in substance to ABU's, per secondary sources).
- **Effective date of equal terms under the Wet meer zekerheid flexwerkers.** Sources give 31 December 2026, while the minister in March 2026 said 1 January 2027 at the earliest. We did not read the Staatsblad or the inwerkingtredingsbesluit.
- **Wtta conditions** (€100,000 guarantee per legal entity, VOG for legal entities, fee cap of €3,611): reported by advisers, not checked on toelatinguitleenmarkt.nl.
- **SFU levy percentage for 2026**, StiPP's 23.4% total and 7.5% employee premium (third party), and the 2026 sector 52 Whk rate.
- **SNA keurmerk norms.** NEN 4400-1 (Dutch-established firms) vs. NEN 4400-2 (foreign firms) was not confirmed on normeringarbeid.nl, nor whether the 25%/20% G-rekening indemnity will survive once the Wtta applies.
- **Belastingdienst invoice requirements** for an agency invoice used for the inlenersaansprakelijkheid regime (the brochure PDF was not read).
- **Whether general NL payroll APIs or bureaus (e.g. Nmbrs, Loket) support uitzend phases, StiPP and the SFU.** Not checked. Whether any embedded NL payroll provider supports staffing is also open.
- **US joint-employer standards in 2026** (DOL FLSA and NLRB). Fetches failed and the search budget ran out.
- **State-specific SUI rules** for temps who refuse reassignment, SUTA-dumping transfer rules, and current federal and state earned-wage-access rules.
- **NCCI or state rules** on assigning workers' comp class codes to temps (whether the client's governing classification applies). Only vendor and third-party sources were found.
- **Bullhorn's US and NL payroll partners**, Avionté's and TempWorks' consolidated-invoice and credit-limit features, and Easyflex's G-rekening invoice split. These are not described in the pages we could read.
- **BPO pricing models** (per FTE, seat, transaction, SLA credits) are general industry knowledge here, not sourced.
- **Current wording of IRS Pub. 15-A's staffing example.** The quoted text is from an older edition.
