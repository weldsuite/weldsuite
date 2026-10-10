# Dutch payroll rules, and what it takes for WeldSuite to run Dutch payroll itself

Researched 8 October 2026. The main primary sources are the Belastingdienst *Handboek Loonheffingen 2026* (March 2026 edition, cited below as "Handboek" with its paragraph numbers: https://download.belastingdienst.nl/belastingdienst/docs/handboek-loonheffingen-lh0221t61fd.pdf), the 2026 rates annex (edition 4, 25 June 2026, cited as "Annex 2026": https://download.belastingdienst.nl/belastingdienst/docs/bijlage-nieuwsbrief-loonheffingen-2026-lh2091b64fd.pdf), the Belastingdienst developer site odb.belastingdienst.nl, Logius, rijksoverheid.nl and wetten.overheid.nl. Claims that only third parties (tax publishers, advisers, vendors) report are marked "(third party)". The web-search budget ran out partway through, so a few items rest on one third-party source and are listed under "Could not verify".

The product owner's position, as relayed to this research: payroll is meant as a paid-per-employee revenue line, there is no concrete customer demand yet, WeldSuite is a Dutch/EU company, and the owner is willing in principle to take legal responsibility for filings and salary payments (approach C).

## Summary

- **The tax maths is the easy part. The cost is in the yearly churn and the edges.** The Belastingdienst publishes the full calculation rules (*rekenvoorschriften*) and XML specifications for free. There is no software certification or keurmerk, only a validation service and test environments. The work is keeping up: for the 2027 tax year the specs went through a beta release (April 2026), a definitive release (July), a Prinsjesdag version of the calculation rules (October), a Tweede Kamer version (1 December) and possibly a v3.0 in January 2027. In 2026 the rates annex went through four editions, including a retroactive change of the tax-free kilometre allowance (€0.23 to €0.25) decided on 17 May 2026. The minimum wage also changes every 1 January and 1 July.
- **Getting a filing channel is a 3 to 4 month project, not a blocker.** Steps: an ODB support subscription (free, approval by review), a PKIoverheid "private services" server certificate from KPN, DigiCert, Digidentity or Cleverbase (KPN quotes about 2 weeks), then a Logius Digipoort connection, which is free but has a stated minimum lead time of 2 to 3 months. Two dated traps: the old Digipoort closes to Belastingdienst traffic on 1 December 2026, so new connections must use the new Digipoort, and Digipoort does not yet accept the G4 certificates that every party must move to before November 2028. Not every vendor runs its own connection: Employes' terms say it files through an "external API".
- **CAOs and pension funds are the real scope multiplier.** Each bedrijfstakpensioenfonds has its own UPA (pension return) instructions, channel and test environment. Each CAO adds pay scales, allowances, extra leave, top-ups and sometimes fund premiums, and the loonaangifte itself carries a CAO code per employee. In the sectors WeldHR targets, the AVV'd CAOs and mandatory funds apply to every employer in the sector, whether or not it joined the employer organisation.
- **Staffing/BPO customers are the hardest Dutch payroll segment.** They sit under the ABU/NBBU staffing CAOs, the sector's mandatory pension fund (StiPP, not verified here), the highest small-employer Whk rate (sector 52 Uitzendbedrijven: 6.63% in 2026, against 1.16% for Zakelijke Dienstverlening I) and, from 31 December 2026, the equal-pay rules of the Wet meer zekerheid flexwerkers. An own engine (C) should not start with them.
- **Legal liability for the tax always stays with the employer.** The Handboek says the employer remains responsible for a correct return even when an intermediary signs and sends it (Handboek §13.2.1). WeldSuite can take on contractual liability (indemnify fines and interest), but it cannot take over the *inhoudingsplicht*. Nmbrs and Employes do the opposite: both cap liability at a year of fees and exclude fines and naheffingen.
- **Dutch payroll software does not hold the money.** Nmbrs, Loket and Employes produce a salary payment batch and the loonheffing payment with its *betalingskenmerk* (payment reference), or push them into the employer's own bank through a bank connection or iDEAL; the employer releases the payment. None of the three, on the pages checked, holds salary funds. Holding and paying out funds would be a regulated payment service (our reading; see §8).
- **2027 brings several calculation changes software must ship by 1 January:** no labour credit on UWV benefits paid through the employer (the *samenvoegbepaling* changes), the 30% ruling becomes 27% with higher salary norms, the WKR free space goes from 2.00% to 2.16% (proposed), a 12% pseudo-final levy on newly provided fossil-fuel company cars (proposed), a higher Aof premium to fund the *vrijheidsbijdrage* (proposed), and the abolition of the eerstedagsmelding (first-day notice). The Wtp pension transition deadline is 1 January 2028, and most of the Wet meer zekerheid flexwerkers also starts that day.
- **Recommendation from this file:** for the Netherlands, ship A (payroll prep + export) first for both segments. If the payroll revenue line proves itself, a scoped C is feasible for SMBs without a CAO and with an insured (non-bpf) pension, on a monthly cycle with the white table only (§10.4). Do not plan C for staffing agencies without a dedicated payroll team.

---

## 1. Gross-to-net components for 2026

### 1.1 Loonbelasting and premie volksverzekeringen

The employer withholds one combined amount, *loonbelasting/premie volksverzekeringen* (wage tax plus the national insurance premiums AOW, Anw and Wlz). Bracket 1 is mostly premium; from bracket 2 onward it is pure tax (Handboek §9.2.1).

| 2026, annual wage | Below AOW age | AOW age, born 1946 or later | AOW age, born 1945 or earlier |
|---|---|---|---|
| Bracket 1: up to €38,883 (born ≤1945: up to €41,123) | 35.75% | 17.85% | 17.85% |
| Bracket 2: up to €78,426 | 37.56% | 37.56% | 37.56% |
| Bracket 3: above €78,426 | 49.50% | 49.50% | 49.50% |

Bracket 1 below AOW age is 8.10% tax + 17.90% AOW + 0.10% Anw + 9.65% Wlz. AOW age is 67 for 2024 through 2027 (Annex 2026 table 1; Handboek §2.3.1).

### 1.2 Heffingskortingen and the employee's choice

*Loonheffingskorting* is the umbrella name for the five tax credits applied in payroll: algemene heffingskorting (general credit), arbeidskorting (labour credit), ouderenkorting, alleenstaande-ouderenkorting and jonggehandicaptenkorting (Handboek §24.1). 2026 amounts (Annex 2026 table 2a/2b):

- **Algemene heffingskorting:** €3,115 for wages up to €29,736, reduced by 6.398% of the wage above that, zero at €78,426. At AOW age: €1,556, reduced by 3.195%.
- **Arbeidskorting** (on current employment income only): 8.324% up to €11,965 (max €996), plus 31.009% from €11,965 to €25,845 (max €4,304), plus 1.950% up to €45,592 (max €385). Maximum €5,685, reduced by 6.510% above €45,592, zero at €132,920. At AOW age roughly half (max €2,840). The first edition of the annex printed €132,290; the second edition corrected it, which shows how easily these numbers go wrong.
- Ouderenkorting €2,067 (phased out at 15% above €46,002), alleenstaande-ouderenkorting €540, jonggehandicaptenkorting €923.
- **The choice:** the employee must ask in writing (usually on the *opgaaf gegevens voor de loonheffingen*) for the credits to be applied, and should do so at one employer only; without a request the employer applies none and the employee settles it in the income tax return (Handboek §24.1, §2.3.1).

**Implication for WeldSuite:** the employee record needs a dated, signed "loonheffingskorting yes/no" flag with history, plus AOW-age and birth-year logic. The Handboek accepts advanced (AES) or qualified (QES) electronic signatures for the opgaaf, or another method with equivalent controls (Handboek §2.3.1), so the WeldHR portal can collect it.

### 1.3 White and green tables, pay periods, special rewards, anonymous rate

- **Witte tabel** (white table, with arbeidskorting) for current employment, including sick pay under art. 7:629 BW for up to 104 weeks and some UWV benefits; **groene tabel** (green table, no arbeidskorting) for income from former employment such as pensions and most benefits (Handboek §9.3.2–9.3.3).
- **Tijdvaktabellen** (period tables) exist per *loontijdvak* (pay period): quarter, month, 4 weeks, week and day (Handboek §5, §9.3). The pay period determines the table. Software may use the published rekenvoorschriften (calculation rules) instead of the printed tables; the tables are generated from them (Handboek §9.2.1). *Voortschrijdend cumulatief rekenen* (running cumulative calculation) is optional but, once used, must be continued if the employer switches software mid-year (Handboek §6, §13.2.1).
- **Tabel bijzondere beloningen** (special-reward table): a percentage table based on the previous year's annual wage, used for bonuses, vakantiebijslag paid once a year, year-end payments, payouts of untaken leave and transitievergoedingen, with a separate offset percentage for the credits (Handboek §9.3.6).
- **Anoniementarief:** 52% without credits and without the premium caps when name, address, BSN or a valid ID copy is missing, or the worker has no valid residence/work permit (Handboek §2.6; Annex 2026 table 12).

### 1.4 Werknemersverzekeringen (employee insurance premiums, employer-paid)

| Premium 2026 | Rate | Rule |
|---|---|---|
| AWf laag / hoog (unemployment fund) | 2.74% / 7.74% | Low rate only for a written, open-ended contract that is not an on-call contract (three J/N indicators per employment in the return). Retroactively high if the contract ends within 2 months or the employee is paid for more than 30% above contract hours in the year (Handboek §7.2). |
| Aof laag / hoog (disability fund) | 6.27% / 7.63% | Low for small employers: total premium wage in year t-2 (2024) of at most €1,082,500 (25 × €43,300). Starters count as small for two years (Handboek §7.5). |
| Wko surcharge (childcare) | 0.50% | On top of Aof (Annex 2026 table 9). |
| Whk (return-to-work fund) | sector rate or individual | Small employers pay the sector rate (e.g. 1.16% Zakelijke Dienstverlening I, 1.77% Horeca algemeen, 6.63% Uitzendbedrijven); medium and large employers get an individual rate. The Belastingdienst sends the rate yearly in a *beschikking* (Annex 2026 table 10; Handboek §7.6). |
| Ufo (government employees) | 0.68% | |
| Maximum premieloon | €79,409/year, €6,617.41/month, €305.41/day | Same caps for Zvw (Annex 2026 table 11). |

**Sectorindeling** matters because it sets the Whk rate. The Belastingdienst assigns the sector by decision within 8 weeks of registering as an employer, based on the activities; pension funds and CAO parties sometimes reuse the sector code, but the Belastingdienst does not consider CAO or pension fund when assigning it (Handboek §7.1.1).

### 1.5 Zvw

Werkgeversheffing Zvw (employer health-care levy) 6.10%; the withheld *bijdrage Zvw* of 4.85% applies only in specific cases (e.g. some directors), up to the same €79,409 cap (Annex 2026 tables 11–12; Handboek §8).

### 1.6 30%-regeling (expatregeling)

2026: up to 30% of wage paid tax-free for qualifying incoming employees with a taxable salary of at least €48,013 (€36,497 for under-30s with a master's), capped at the WNT norm of €262,000 (Annex 2026 table 12). From 1 January 2027 the maximum becomes 27% with higher salary norms, with transition rules by start year; this was enacted in the Belastingplan 2025 (third party: https://www.loyensloeff.com/nl/insights/news--events/news/van-30-regeling-naar-een-27-regeling-versoepeling-of-versobering/ ; https://www.salarisvanmorgen.nl/2026/04/01/expatregeling-in-2026-en-2027-wat-wijzigt-er/). The exact 2027 salary norms were not yet published at the time of research.

### 1.7 Werkkostenregeling, travel and home-working allowances

- **WKR vrije ruimte** (free space for tax-free benefits): 2.00% of the total fiscal wage bill up to €400,000 plus 1.18% above; the excess is taxed at an 80% final levy paid by the employer (Annex 2026 table 13; Handboek §10). Proposed for 2027: 2.16% on the first €400,000, and the separate exemption for discounts on own products (€500, 20%) disappears (third party: https://www.grantthornton.nl/insights/themas/prinsjesdag/2026/belastingplan-2027-wat-betekent-dit/).
- **Reiskosten:** tax-free travel allowance €0.25 per km, retroactive to 1 January 2026 by decision of 17 May 2026 (Annex 2026 edition 4, table 13). Home-working allowance €2.45 per day.

### 1.8 Company car (auto van de zaak)

Bijtelling (taxable private-use addition) is 22% of the list price for cars first registered from 2017 (25% before 2017, 35% for cars older than 16 years). Zero-emission cars get a discount up to a price cap: 4 points for 2026 registrations (18% up to €30,000), 5 points for 2025 (17%), 6 points for 2023–2024 (16%) (Annex 2026 table 12). The 2027 proposal adds a 12% pseudo-final levy on the list price of newly provided non-zero-emission cars (third party: Grant Thornton above).

**Implication for WeldSuite:** every rate above must be stored per tax year (and some per half year), never as constants. Several values arrive by Belastingdienst *beschikking* per employer (Whk rate, sector, Aof size) and must be entered or imported per employer per year. A retroactive change like the June 2026 km rate means recalculating paid periods and filing corrections.

## 2. Wage law

- **Minimum wage (WML):** 21 and older €14.71 gross per hour from 1 January 2026 and €14.99 from 1 July 2026; youth rates from €4.41 (age 15) to €11.77 (age 20) in January (https://www.rijksoverheid.nl/onderwerpen/minimumloon/bedragen-minimumloon/bedragen-minimumloon-2026). Amounts are set twice a year (Annex 2026 table 8). The payslip must show the applicable minimum hourly wage (art. 7:626 BW).
- **Vakantiebijslag** (holiday allowance): at least 8% of wage, statutorily computed over wage up to three times the minimum wage; a CAO may lower or remove it for higher earners (Wml art. 15–16, https://wetten.overheid.nl/BWBR0002638/).
- **Vacation days:** at least four times the agreed weekly hours per year (art. 7:634 BW). Statutory days lapse 6 months after the end of the year they were earned unless the employee could not reasonably take them (art. 7:640a); extra days lapse after 5 years (art. 7:642). At the end of employment untaken days are paid out and the employer must hand over a statement of remaining days (art. 7:641) (https://wetten.overheid.nl/BWBR0005290/).
- **Paying wages:** after each pay period, which may be no shorter than a week and no longer than a month (art. 7:623 BW).
- **CAO and AVV:** a CAO binds the employers that are members of the signing employer organisation (Wet op de cao, https://wetten.overheid.nl/BWBR0001937/). The Minister of SZW can declare CAO provisions *algemeen verbindend* (AVV), binding every employer in the sector (Wet AVV, https://wetten.overheid.nl/BWBR0001987/). CAOs add payroll rules on top of the law: pay scales and annual steps, shift and overtime allowances, extra vacation days, year-end bonuses, top-up of sick pay above the statutory 70%, the mandatory pension fund, and sometimes sector-fund premiums. The loonaangifte carries a CAO code per income relationship, from a code table the Belastingdienst updates each year (ODB planning: https://odb.belastingdienst.nl/salaris/planningsoverzicht-salaris/).

**Implication for WeldSuite:** WeldHR needs per-employee contract hours, contract type (open-ended, written, on-call), applicable CAO and scale, and a leave ledger that separates statutory from extra days with their different expiry rules. These are needed in all three approaches, because an export under A must carry them too.

## 3. Pensions

- **Verplichte bedrijfstakpensioenfondsen** (mandatory industry pension funds): an employer in a covered sector must join the sector fund whether or not it signed the CAO. Large examples are ABP (government, education), PFZW (care), PMT and PME (metal and technology), bpfBOUW (construction), Pensioenfonds Detailhandel (retail) and PGB (several sectors). Premium bases, franchise (offset) and eligibility are fund-specific; the fiscal maximum pensionable salary for 2026 is €137,800 and the minimum fiscal franchise €19,172 (Annex 2026 table 12). The Belastingplan 2027 proposes freezing the €137,800 cap for six years (third party: Grant Thornton above).
- **Wtp transition:** the Wet toekomst pensioenen took effect on 1 July 2023; all pension schemes must comply by 1 January 2028 (Handboek §21.4.1). According to PwC, about thirty funds moved on 1 January 2026, around 61 are planned for 2027 and the last 25 for 1 January 2028 (third party: https://www.pwc.nl/nl/actueel-en-publicaties/diensten-en-sectoren/pensioenen/overzicht-pensioenactualiteiten-2026-q1.html). PMT received DNB approval to move on 1 January 2026 (third party: https://www.banken.nl/nieuws/26565/pensioenfonds-metaal-techniek-krijgt-groen-licht-voor-overstap-naar-nieuwe-stelsel); PME plans 1 January 2027 (third party: https://europeanpensions.net/ep/PME-set-to-switch-to-new-pension-system-from-1-january-2027.php).
- **UPA (uniforme pensioenaangifte):** the standard message in which payroll software reports wage and employment data per employee per period (monthly or 4-weekly) to a pension administrator; the fund then invoices the employer, and sends an estimated invoice if no UPA arrives. The Pensioenfederatie owns the specification and SIVI maintains it; each fund publishes its own "fund-specific" instructions on top (PGB UPA handleiding 2026: https://www.pensioenfondspgb.nl/globalassets/pdfs/upa/2026/upa-handleiding-2026.pdf). Channels differ per fund: PGB requires a submission account and a UPA authorisation via its employer portal; Pensioenfonds Detailhandel (administered by Capgemini) takes UPA through an API or FTP, with a separate test environment, a per-employer UPA key and IP whitelisting (https://pensioenfondsdetailhandel.nl/content/Publicaties/UPA-aanleverinstructie.pdf). Fund changes happen every year; for 2026 AFAS reports administrators changing for several sector funds (vendor: https://help.afas.nl/vraagantwoord/NL/SE/138331.htm).

**Implication for WeldSuite:** under C, every pension fund supported means a fund-specific UPA mapping, onboarding and test track, plus Wtp-driven scheme changes during 2026–2028. Employers with an insured pension (insurer or PPI) need only a premium deduction on the payslip, no UPA. That is the cheapest pension case to support first.

## 4. Loonaangifte (payroll tax return)

### 4.1 Frequency, deadlines and payment

- Monthly or 4-weekly *aangiftetijdvak* (return period), chosen per employer; a change for 2027 had to be requested by 14 December 2026 (Handboek §13.1). Domestic staff and working children file yearly.
- Filing and payment deadlines per period are in the yearly *Aangiftebrief loonheffingen*, together with a unique *betalingskenmerk* per period. Software can derive dates and period codes from the ODB "TijdvakCodesAangifteBetaalDatums" file (Handboek §13.1, §13.4; ODB release history: https://odb.belastingdienst.nl/documentatie/loonheffingen-aangifte-2027v1-5/).
- Payment counts when it reaches the Belastingdienst account. **From 1 May 2026 the Belastingdienst uses a new account, NL04 RABO 0200 1122 44; the old ING account works for 2026 returns only, so from 2027 payments must go to the new IBAN** (Handboek §13.4.1).
- Filing is digital only, by one of three routes: the Belastingdienst's own online return in *Mijn Belastingdienst Zakelijk* (max 10 income relationships per payroll tax number), third-party software via Digipoort, or an intermediary (Handboek §13.2.1).

**Implication for WeldSuite:** under A, small customers (10 or fewer employees) could in principle file themselves in the Belastingdienst portal, but with no calculation support; this is not a realistic product. The new Belastingdienst IBAN must be in any payment-batch feature before January 2027.

### 4.2 Content, income relationships and the UWV polisadministratie

The return has a collective part (employer totals, final levies, deductions) and an employee part per *inkomstenverhouding* (IKV, income relationship): identity and BSN, contract indicators, wages per insurance, hours paid, premiums, withheld tax, labour credit applied, CAO code and more (Handboek §13, §3.4). The employee part feeds UWV's **polisadministratie**, which UWV uses to set unemployment and sickness benefits and passes to municipalities, pension funds and others; employees see it as their *digitaal verzekeringsbericht* (Handboek §12–13). This is why errors in hours or wages must be corrected even if no tax changes (Handboek §14.1.1).

### 4.3 Specifications, versions and yearly cadence

- The Belastingdienst publishes the *Gegevensspecificaties aangifte loonheffingen* (data specification), message specification, XSD schema, code tables, a control list and the *rekenvoorschriften* (calculation rules with CSV tables) per tax year on odb.belastingdienst.nl under "Salaris". The Handboek says these documents do not have the status of law; the rules for income relationships are being moved into a Besluit IKV (Handboek §3.4).
- Cadence for tax year 2027 (ODB planning): beta release with data spec v1.0 and XSD v1.0 on 8 April 2026; definitive release with spec v2.0, XSD v2.0 and the structure version of the calculation rules on 10 July 2026, plus the validation service; updated CAO, country, sector, payroll ledger and annual-statement tables on 2 October; the Prinsjesdag version of the calculation rules on 13 October; the Tweede Kamer version on 1 December; a spec v3.0 "if needed" on 13 January 2027 (https://odb.belastingdienst.nl/salaris/planningsoverzicht-salaris/). The 2027 release reached v1.5 on 8 October 2026; the 2026 release is at v09 and the 2025 release reached v13 (https://odb.belastingdienst.nl/documentatie/?_sfm_status=Actueel&_sfm_doelgroep=Salaris). The structure of the calculation rules changed mid-year too, e.g. an extra annual-wage limit in the special-reward tables for AOW-age employees (https://odb.belastingdienst.nl/release-lh2027v1-4-is-gepubliceerd/).
- The Belastingdienst also publishes an XML Auditfile Salaris (XAS) standard for handing the payroll ledger to auditors.

### 4.4 Corrections

Before the filing deadline the employer resends a complete return (or a supplementary one, if the software supports it); after the deadline it sends a correction message per period. Corrections go back five years and are checked against the specification of their own year; correcting a past year can trigger tax interest and fines. Software must support withdrawing an income relationship by correction message, for example after a wrong BSN (Handboek §14). A new software package or intermediary must continue the IKV numbers, start dates and running cumulative calculation of the previous one, and the employer must still be able to correct five years back (Handboek §13.2.1).

**Implication for WeldSuite:** the data model needs immutable per-period return snapshots per IKV, with correction lineage, and must keep per-year rule versions for at least five years. Mid-year onboarding of a customer requires importing year-to-date cumulatives and existing IKV numbers.

### 4.5 Submission channel: what a software vendor needs

The Handboek lists the requirement plainly: "a PKIoverheid services server certificate and software suitable for Digipoort", over the WUS channel (messages up to 15 MB compressed) or the FTP large-message channel (above 80 MB, needs a Logius FTP account) (Handboek §13.2.1). The steps for WeldSuite:

| Step | What | Lead time / cost | Source |
|---|---|---|---|
| 1 | ODB support subscription: registration as software developer, gives a *swo-nummer*, access to the Validatie Test Service (VTS), test environments and the developer service desk. Approval after review. | Free (no price stated); no lead time stated | https://odb.belastingdienst.nl/dienstverlening-aan-softwareontwikkelaars-en-gegevensleveranciers/ |
| 2 | PKIoverheid private-services server certificate (TLS client certificate for system-to-system Digipoort traffic) from one of the four trust service providers: Cleverbase, Digidentity, KPN, DigiCert. Register once as subscriber with authorised representatives; DigiCert's guide says the OIN or KvK-derived number must be in the certificate (third party). | Paid, price per TSP. KPN: within 2 weeks for a complete application, up to 4 weeks if reauthorisation is needed | https://www.logius.nl/domeinen/toegang/pkioverheidcertificaat-aanvragen ; https://www.kpn.com/zakelijk/pki-certificaten/pki-overheid-servercertificaat |
| 3 | Logius Digipoort connection: register in the Aansluit Suite Digipoort, choose message flow and interface, submit the application; Logius supports the first connection. New WUS and ebMS connections are only possible on the new Digipoort. | Free; "minimum lead time two to three months" | https://www.logius.nl/onze-dienstverlening/gegevensuitwisseling/digipoort/aanvragen-wijzigen ; https://aansluiten.procesinfrastructuur.nl/site/ |
| 4 | Build and test: VTS validates XML against XSD and business rules; the Aansluit Suite simulates Digipoort dialogues (no content checks); the Belastingdienst test facility (Digipoort pre-production plus Belastingdienst acceptance environment) tests real status flows. | Not stated | https://odb.belastingdienst.nl/testvoorzieningen-voor-softwareontwikkelaars/ |
| 5 | Authorisation per customer: an intermediary may sign and send the return on the employer's behalf "if you have authorised him" (Handboek §13.2.1). | Per customer | Handboek |

Timing traps as of October 2026:
- The old Digipoort stops accepting Belastingdienst messages on 1 December 2026 (eerstedagsmelding flow already on 1 November 2026) (https://odb.belastingdienst.nl/vanaf-1-december-2026-is-de-oude-digipoort-niet-meer-in-gebruik/ ; https://odb.belastingdienst.nl/vanaf-1-november-2026-is-de-oude-digipoort-niet-meer-in-gebruik/).
- PKIoverheid is moving to G4 certificates, single-purpose per certificate; G1 Private and G3 certificates expire by November 2028 at the latest, and the move is mandatory for Digipoort, but Logius states Digipoort does not yet support G4 (https://www.logius.nl/english/pkioverheid/logius-introduces-new-generation-pkioverheid-certificates ; https://odb.belastingdienst.nl/en/?p=2856 ; https://logius.nl/diensten/pkioverheid). A new connection in 2027 will therefore need a certificate swap before late 2028.
- Logius replaces its own Digipoort server certificate periodically (most recently 8 October 2026), which breaks clients that pin it (https://www.logius.nl/actueel/logius-vervangt-digipoort-certificaat-op-8-10-2026).

Shortcut: file through a third party instead of an own Digipoort connection. Employes' terms say "for the returns we connect through an external API" (art. 9, https://www.employes.nl/algemene-voorwaarden/). AFAS runs an "AFAS Digipoort Service" for its online customers (vendor: https://help.afas.nl/help/NL/SE/Sys_CS_DigiPt.htm). Which gateway providers exist, and their prices, could not be researched.

UWV runs a separate "UWV Digipoort" with its own vendor track: PKIoverheid certificate, UWV specifications, a test trajectory, then a pilot, after which UWV lists the vendor as approved (https://uwv.nl/nl/digipoort/aansluiten-digipoort). It is not needed for the loonaangifte, which goes to the Belastingdienst.

**Implication for WeldSuite:** a realistic channel timeline is 3 to 4 months of elapsed time, mostly Logius lead time, and can run in parallel with building the engine. Digipoort WUS is SOAP over mutual TLS with the PKIoverheid certificate; the Cloudflare Workers runtime would need an outbound mTLS certificate binding for this, or a small dedicated sender service. That has to be confirmed in a spike before committing.

### 4.6 Certification or keurmerk

None for payroll software. The ODB subscription approves the registration of the developer, not the software; the VTS is validation, not certification (https://odb.belastingdienst.nl/dienstverlening-aan-softwareontwikkelaars-en-gegevensleveranciers/). The Handboek puts the burden on vendors: "software vendors must make sure their software meets our specifications" (Handboek §13.2.1).

## 5. Records and documents

- **Loonstrook** (payslip, art. 7:626 BW): at every payment that differs from the previous one, showing gross pay and its components, every deduction, the applicable minimum hourly wage, employer and employee names, the pay period, agreed working hours, whether the contract is written and open-ended, and whether it is an on-call contract. Electronic payslips need the employee's explicit consent and must remain storable and accessible later, including after employment ends (https://wetten.overheid.nl/BWBR0005290/ ; Handboek §12). Wages and hours on the payslip should match the return, because employees check them against the polisadministratie (Handboek §12). The Book 7 text shows a scheduled change to art. 7:626 from 1 January 2028, which matches the start date of the Wet meer zekerheid flexwerkers.
- **Jaaropgaaf** (annual statement): per employment after year end, form-free, at least employee and employer name, wage for tax, tax withheld, labour credit applied and BSN; the last payslip of the year may serve as jaaropgaaf (Handboek §15).
- **Loonstaat** (payroll ledger): one per employee per employment per year, created before the first payment; software that deviates from the model needs permission from the tax office. Next to it the employer keeps the employment contract, the opgaaf gegevens, the ID copy, leave and sickness records, target-group statements and the reconciliation between returns and the general ledger (Handboek §3.2.1–3.2.2, §11).
- **Opgaaf gegevens voor de loonheffingen:** before the first working day: name and initials, BSN, address, date of birth, country of residence if abroad, and the loonheffingskorting request, dated and signed (Handboek §2.3.1).
- **ID verification:** before work starts, a legible copy of a valid ID with all personal data (including the back where the BSN is printed), kept in the payroll records. Remote digital verification is allowed if the employer can show it was careful. Failure means the 52% anonymous rate or a fine of up to €6,709 for the employer, and the same maximum for an employee who refuses (Handboek §2.2).
- **Retention:** payroll records 7 years (fiscal retention duty); ID copies, opgaaf forms and statements at least 5 years after employment ends. Records must remain usable in electronic form; printouts alone do not meet the duty (Handboek §3.5.2).
- **BSN and AVG (GDPR):** the employer must collect and use the BSN for the loonaangifte (Handboek §2.3.1). The AVG rules for national identification numbers (Article 87 GDPR, Dutch implementing act) were not re-read for this file; see "Could not verify".

**Implication for WeldSuite:** WeldHR already holds bank and tax data in an encrypted blob. Under any approach it needs: ID-copy storage with verification metadata, a signed opgaaf with history, per-document retention timers (7 years for payroll, 5 years after exit for ID and opgaaf), and payslip archive access for ex-employees through the portal.

## 6. Sickness and termination as they affect payroll

- **Loondoorbetaling bij ziekte:** at least 70% of wage for 104 weeks, but in the first 52 weeks at least the minimum wage; the 70% applies to wage up to the daily maximum (€305.41 in 2026); 6 weeks only for employees past AOW age and some domestic staff (art. 7:629 BW; Annex 2026 table 11). CAOs commonly top this up (not verified per CAO). Sick pay under art. 7:629 stays on the white table; beyond the statutory period it moves to the green table (Handboek §9.3.2).
- **Eindafrekening** (final pay): pay out untaken vacation days (art. 7:641), settle accrued vakantiebijslag and other reservations, issue the statement of remaining leave days. Payouts are taxed with the special-reward table (Handboek §9.3.6).
- **Transitievergoeding** (statutory severance): one third of a monthly salary (including holiday allowance) per year of service, capped in 2026 at €102,000 or one year's salary if higher (art. 7:673 BW; amount third party: https://www.rendement.nl/transitievergoeding/nieuws/maximale-transitievergoeding-is-in-2026--102000.html). It must appear on the payslip and is taxed with the special-reward table (Handboek §12, §9.3.6).
- **UWV benefits paid through the employer:** from 2027 no labour credit on the benefit part, applied by combining the green table on the total with the white-table credit on the wage part, in two income relationships; the Belastingdienst writes "we assume the calculation method is built into your software package in 2027" (Nieuwsbrief Loonheffingen 2027, 19 August 2026: https://download.belastingdienst.nl/belastingdienst/docs/nieuwsbrief-loonheffingen-2027-lh2091t71fd.pdf).

## 7. Changes in flight as of October 2026

| Change | Effect on payroll | Date | Status / source |
|---|---|---|---|
| Wet meer zekerheid flexwerkers | Zero-hour contracts replaced by contracts with a minimum and maximum of hours; agency workers get at least equal terms to comparable permanent staff; chain rule waiting period extended | Equal terms for agency workers 31 Dec 2026; the rest 1 Jan 2028 | Adopted by Eerste Kamer 7 July 2026 (https://www.eerstekamer.nl/nieuws/20260707/meer_zekerheid_voor_flexwerkers); Stb. 2026, 205 and 206 (https://www.njb.nl/wetgeving/staatsbladen/meer-zekerheid-flexwerkers/); dates third party (https://www.salarisvanmorgen.nl/2026/07/07/wet-meer-zekerheid-flexwerkers-per-1-januari-2028-een-feit/) |
| Wet DBA enforcement, Wet VBAR | Belastingdienst enforces against false self-employment since 2025, without default fines in 2026; VBAR dropped, replaced by a legal presumption of employment below an hourly rate (about €36 indexed, expected from 2027) and a planned Zelfstandigenwet (target 2028) | 2027 / 2028 | Third party only: https://bieb.knab.nl/ondernemen/zzp-regels-uitgelegd-dit-is-de-actuele-stand-van-zaken |
| Wtta (admission regime for labour providers) | Affects staffing customers; covered in the separate staffing file | n/a | Not researched here |
| Samenvoegbepaling | No labour credit on UWV benefits paid via employer | 1 Jan 2027 | Published in Staatscourant (Nieuwsbrief LH 2027) |
| 30% becomes 27%, higher norms | New percentage and norms per start year | 1 Jan 2027 | Enacted (third party, §1.6) |
| Belastingplan 2027 | Indexation at 48% (*tabelcorrectiefactor* 1.01248), arbeidskorting up (third parties report €5,929 max), ouderenkorting down, WKR 2.16%, own-product exemption ends, 12% pseudo-levy on new fossil company cars, higher Aof premium to raise €1.5 bn for the *vrijheidsbijdrage* (defence contribution) | 1 Jan 2027 | Bills sent 15 Sept 2026, still in parliament (third party: https://www.salarisvanmorgen.nl/2026/09/15/belastingplan-2027-overzicht-belangrijkste-fiscale-maatregelen/ ; https://www.taxlive.nl/nl/documenten/nieuws/belastingschijven-en-tarieven-2027/) |
| Eerstedagsmelding abolished; opting-in notice becomes a retention duty | Fewer messages | 1 Jan 2027 | Fiscale verzamelwet 2027 (third party: https://www.salarisvanmorgen.nl/2026/07/16/eerstedagsmelding-vervalt-definitief-vanaf-1-januari-2027/) |
| Old Digipoort shut | Vendors must be on new Digipoort | 1 Dec 2026 | ODB (§4.5) |
| New Belastingdienst IBAN mandatory | Payment batches | 1 Jan 2027 | Handboek §13.4.1 |
| Wtp transition deadline | Pension schemes, UPA content | 1 Jan 2028 | Handboek §21.4.1 |
| Pay transparency directive | Pay data reporting; draft implementing regulation in consultation | Not confirmed | https://odb.belastingdienst.nl/internetconsultatie-regeling-implementatie-richtlijn-loontransparantie/ |
| PKIoverheid G4 | Certificate migration for Digipoort | before Nov 2028 | Logius (§4.5) |

## 8. Paying salaries, and how Dutch payroll software handles money

- **Mechanism:** employers pay net salaries from their own business account, usually by uploading a SEPA credit transfer batch (ISO 20022 pain.001) generated by the payroll software, and pay the loonheffingen separately to the Belastingdienst with the period's betalingskenmerk (Handboek §13.4.1). The pain.001 category purpose code SALA (salary payment) marks the batch as payroll for the bank; this comes from the ISO 20022 code list and could not be fetched in this session.
- **Timing:** wages are due after each pay period (art. 7:623 BW); the loonheffingen payment is due on the date in the Aangiftebrief and counts on arrival, with a 7-day grace period (Handboek §13.4.2, §13.5.1).
- **Nmbrs:** a "direct bank connection" with ABN AMRO, bunq, ING and Rabobank to "set up the payment for salaries and payroll tax directly in your bank", presented as an alternative to SEPA files; the page does not describe the technology or approval flow (https://www.nmbrs.com/nl/payroll/bankkoppeling). Separately, its accounting product offers a business account run with Swan, an e-money institution, with Nmbrs stating it is "not a bank" (https://www.nmbrs.com/nl/accounting/features/nmbrs-pay/); nothing says that account pays salaries.
- **Loket:** "after approving the loonaangifte you can pay directly via iDEAL or generate a SEPA file" (https://loket.nl/functionaliteiten/salaris/).
- **Employes:** after the run "you only need to pay your employees via a payment file"; the same file covers the loonheffing; there is an "option to automate the payment" without detail (https://www.employes.nl/product/salarisadministratie/).
- **Filing name and liability:** in all cases the return is the employer's, under the employer's payroll tax number; an intermediary or vendor signs and sends with the employer's authorisation, and the employer remains responsible for its correctness (Handboek §13.2.1). Employes' terms require the customer to warrant authority to file, exclude liability for fines, and cap total liability at one year of fees (art. 9, 13: https://www.employes.nl/algemene-voorwaarden/). Nmbrs caps liability at 12 months of fees, maximum €100,000, and lists "fines or naheffingen" as excluded indirect damage (art. 11: https://www.nmbrs.com/hubfs/Legal/Algemene%20Voorwaarden%20Nmbrs%20V01092026.pdf). Loket's terms were not checked.

**Implication for WeldSuite:** the Dutch norm supports the coordinator's understanding: software does not hold funds. Generating a pain.001 batch plus the Belastingdienst payment (new IBAN, betalingskenmerk) fits WeldBooks, which already stores IBAN/BIC. A bank-connection or iDEAL flow where the employer approves in its own bank stays outside payment-service regulation as long as WeldSuite never receives the money. If WeldSuite wanted to collect payroll funds and pay employees itself, that would in our reading be a payment service needing a DNB/PSD2 licence or a licensed partner (not verified with DNB). Note also that "taking legal responsibility" can only be contractual: WeldSuite can indemnify fines, interest and correction costs, but the Belastingdienst assesses the employer. Payrolling, where the provider becomes the legal employer, is a different business with its own rules and is out of scope here.

## 9. Penalties and liability

- **Late or missing return:** €83 per return after a 7-day grace period; same fine possible for an incorrect or incomplete return, though the Belastingdienst says it is "for now reticent" in imposing that one (Handboek §13.5.2, §13.5.4).
- **Late or short payment:** 3% of the amount, minimum €50, maximum €6,709, with a 7-day grace period if the previous return was paid on time (Handboek §13.5.1).
- **Repeat offenders:** up to €1,675 per return default and up to 10% of the late tax (max €6,709). With gross negligence or intent, a *vergrijpboete* (penalty for culpable conduct) instead, plus tax interest on corrections (Handboek §13.5.5, §14.5).
- **Identity failures:** up to €6,709 (Handboek §2.2.3).
- **Chain liability:** hirers of staff, directors and contractors in a chain can be held liable for unpaid payroll taxes, which is why staffing customers use G-accounts (Handboek §13.6). This matters for staffing clients; details belong in the staffing file.
- **Vendor liability:** no statutory regime for payroll software vendors was found. Exposure is contractual and reputational. The market norm (Nmbrs, Employes) is to cap liability at a year of fees and exclude fines.

**Implication for WeldSuite:** the per-return fines are small; the real exposure is employees paid wrongly (net pay errors, minimum-wage underpayment, which the Labour Inspectorate enforces) and UWV benefit errors from wrong polis data. If the owner wants to differentiate by guaranteeing filings, the contract should cover fines and interest caused by WeldSuite errors, with an insurance-backed cap, rather than open-ended liability.

## 10. Effort signals and an honest assessment of approach C

### 10.1 How often the rules change

- At least two fixed rate dates (1 January, 1 July for the minimum wage), plus four to five Belastingdienst releases per tax year (§4.3), plus mid-year corrections of published figures (four editions of the 2026 annex: December, January, March, June).
- Retroactive changes happen (the €0.25 km rate, decided in May for January).
- Pension funds and CAOs change on their own schedules; the 2026–2028 Wtp transitions add fund-specific changes every January.
- New-law dates in 2027 and 2028 listed in §7.

### 10.2 Market signals

- The incumbents (Nmbrs, Loket, AFAS, Employes; also Visma, ADP, Exact) market "built-in legislation and CAOs" as the core value. Employes' homepage claims its platform includes "the latest legislation and CAO agreements" (https://www.employes.nl/).
- At least one smaller vendor files through an external API rather than its own channel (Employes), and both vendors whose terms were read cap their liability.
- Vendor statements about the cost of keeping up, and the number of Dutch payroll software vendors, could not be found within this research (search budget exhausted). No count is given here.

### 10.3 What C would take: a concrete plan

**Channel (months 0–4, parallel to engine work):**
1. Apply for the ODB support subscription; get VTS access and the 2026/2027 release packages (data spec, XSD, rekenvoorschriften with CSV tables, code tables).
2. Register WeldSuite as subscriber with a TSP (KPN or DigiCert, both with documented Digipoort products) and order a PKIoverheid private-services server certificate (about 2–4 weeks). Plan the G4 swap for 2027–2028.
3. Register in the Aansluit Suite and request the new-Digipoort WUS connection from Logius (2–3 months minimum).
4. Decide whether to run the sender on Workers (mTLS binding) or a small dedicated service; spike it against the Aansluit Suite.
5. Test against the Belastingdienst test facility (pre-production plus acceptance), then file real returns for one friendly employer.
6. Alternative: contract a filing gateway API for the first year and move to an own connection later.

**Engine (months 0–12 for a narrow v1):** implement the rekenvoorschriften (not the printed tables) with year-versioned parameters; IKV administration and correction messages; premiums with employer-specific beschikkingen; payslip, jaaropgaaf, loonstaat, XAS export; SEPA batch plus loonheffingen payment; WeldBooks journal (the NL chart already has 1800 Loonheffing te betalen and 4110 Lonen en salarissen); parallel-run checks against the Belastingdienst's own published examples and a competitor package for a full year before general availability.

### 10.4 Minimum first release for C

In scope:
- Employers without a CAO, or only with CAO rules entered manually as pay components, and with no mandatory industry pension fund (insurer or PPI pension as a payslip deduction). Practically: business services, IT, consultancy (Whk sectors 43–45).
- Monthly pay period and monthly return period; resident employees; white table, special-reward table, anonymous rate.
- Loonheffingskorting yes/no; under and over AOW age; AWf low/high with the review rules; Aof low/high; Whk and Aof size from the employer's beschikking; Zvw werkgeversheffing.
- Vakantiebijslag (reserve monthly, pay yearly or monthly), statutory and extra leave, final pay with leave payout.
- DGA (director-major shareholder) payroll: common in small BVs, no employee insurances, minimum usual salary €58,000 (Annex 2026 table 12).
- Company car bijtelling, km and home-working allowances, a simple WKR free-space tracker, 30%/27% ruling.
- Corrections, payslip, jaaropgaaf, loonstaat, pain.001 batch, Belastingdienst payment reference, WeldBooks posting.

Out of v1: CAO engines, UPA and mandatory funds, green-table income (pensions, benefits through the employer, including the 2027 combination rule), own-risk bearers (*eigenrisicodragers*), 4-weekly and weekly pay, staffing agencies (staffing CAO phases, StiPP, sector 52), non-residents and cross-border rules, wage garnishments (*loonbeslag*), wage-cost subsidies (LKV), students regime, DGA-only edge cases beyond the basics.

### 10.5 Which pension funds and CAOs to add first

- By WeldHR's two segments: staffing agencies need the staffing CAO plus StiPP; the general SMB base is spread across retail (Pensioenfonds Detailhandel, retail CAO), hospitality (horeca fund and CAO), construction (bpfBOUW), care (PFZW) and metal/technology (PMT, PME). Each fund means a UPA integration with its own test track (§3), and each CAO a rule set that changes at least yearly.
- A sensible order, if C proceeds: first the no-CAO/insured-pension segment (§10.4), then one AVV'd CAO with a large SMB population and a fund with a modern API channel (Detailhandel is an example: API plus test environment), then staffing.
- How many employees fall under AVV'd CAOs, and the exact list of mandatory funds, could not be verified here.

### 10.6 Team and annual maintenance (estimate, not sourced)

- Build: 3–4 engineers plus one Dutch payroll specialist (a *salarisadministrateur* or payroll tax adviser) for about 12 months to a v1 as in §10.4, with a full parallel-run year before broad sale. Each CAO plus pension fund pair after that: roughly 1–3 engineer-months to build and test, then yearly upkeep.
- Run: at minimum 1.5–2 FTE permanently on Dutch rules (yearly releases, July minimum wage, Prinsjesdag and December rate drops, January hotfixes, corrections support), plus customer support that can answer payroll questions. December and January are fixed crunch periods every year.
- Fixed costs are small: the Digipoort connection and ODB subscription are free; PKIoverheid certificates cost a recurring fee per certificate (price not found).

### 10.7 Verdict for the Netherlands

- **A (prep + export)** fits both segments now. The data WeldHR must collect is the same as under C (contracts with the three AWf indicators, hours, leave ledgers, opgaaf, ID copy, CAO and scale), so it is not throwaway work.
- **B (embedded provider)** depends on whether a Dutch provider exposes an embeddable API (Nmbrs, Loket); that is for the providers file.
- **C** is feasible for a Dutch company and the legal setup is clear, but it only pays off at scale, because the yearly rules work is the same for 10 customers as for 10,000. With no customer demand yet, start with A, measure demand, and take C on only for the §10.4 segment. Staffing agencies should stay on A or B.

## Could not verify

- The exact 2027 bracket limits, credits and Aof rate: Belastingplan 2027 is still in parliament and the third-party figures conflict (e.g. first-bracket rate reported as 36.23% by one source and as "reduced by 0.06 points" by another).
- Exact 2027 salary norms for the 27% ruling.
- Whether the Fiscale verzamelwet 2027 (eerstedagsmelding abolition, opting-in) has been adopted.
- The rechtsvermoeden (presumption of employment by hourly rate) law, its threshold and start date, and the Belastingdienst's DBA enforcement stance for 2027: only third-party sources.
- Wtta details and dates (left to the staffing file).
- CAO coverage statistics (share of employees under a CAO or AVV'd CAO) and the current list of mandatory industry pension funds; the Wtp transition dates per fund beyond those cited.
- StiPP's UPA channel and the staffing CAOs' payroll rules.
- The legal mechanism by which the Belastingdienst checks an intermediary's authorisation for loonaangifte sent via Digipoort, and whether the return records the intermediary.
- Whether a vergrijpboete or other sanction can reach a software vendor as co-perpetrator.
- The deadline for handing out the jaaropgaaf (not stated in the Handboek passage read).
- ISO 20022 category purpose code SALA and Dutch bank conventions for salary batches (from general knowledge, page fetch blocked).
- Whether Nmbrs, Loket or Employes hold a PSD2 payment-institution licence, how Nmbrs' bank connection works technically (PSD2 payment initiation or bank APIs), and what Loket's iDEAL option pays (salaries or loonheffingen) and through which provider. Loket's liability terms.
- PKIoverheid certificate prices; Belastingdienst review time for the ODB subscription; who offers Digipoort filing gateways and at what price.
- Vendor statements on the cost of maintaining Dutch payroll, and the number of Dutch payroll software vendors.
- AVG rules on processing the BSN in HR systems beyond the loonheffingen duty.
