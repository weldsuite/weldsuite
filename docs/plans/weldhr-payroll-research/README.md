# Payroll research for WeldHR (Netherlands and United States)

Research done 8 October 2026 for [the payroll plan](../weldhr-payroll.md). Each
file cites its sources inline and ends with a list of items it could not
verify. Check those before building on them. A shared web-search budget ran
out during the research, so later sections of most files rest on direct page
fetches and fewer sources. The files mark where.

| File | Covers |
|---|---|
| [codebase.md](codebase.md) | What exists in WeldHR, WeldBooks, time tracking, the portal, connectors and billing that payroll would plug into, the gaps, and the foundations every approach needs |
| [nl-rules.md](nl-rules.md) | Dutch gross-to-net for 2026 and 2027 changes, wage law, pensions and UPA, the loonaangifte and how a vendor gets a Digipoort channel, records, sick pay and termination, how Dutch payroll software handles money, liability, and what an own engine would take (with a minimal first scope) |
| [us-rules.md](us-rules.md) | Federal, state and local payroll tax for 2026 including the OBBBA W-2 changes, deposits and returns, wage-and-hour rules, benefits, moving money and payment rails, what it takes to act as a payroll provider (incl. as a non-US company), tax engines, and a self-service variant |
| [nl-providers.md](nl-providers.md) | The Dutch payroll market (Loket, Nmbrs, Exact, AFAS, Youforce, Employes, staffing packages), their APIs and write capabilities, white-label and reseller economics, global providers with NL coverage, unified APIs, file-based export |
| [us-providers.md](us-providers.md) | US embedded payroll (Check, Gusto Embedded, Zeal, Everee, Salsa, Rollfi, ADP), who is liable and who moves money, eligibility for a non-US partner, staffing fit, export routes into existing US payroll, unified APIs |
| [competitors.md](competitors.md) | How Zoho, Odoo, Exact, Xero, QuickBooks, Business Central, Personio, HiBob, Factorial, BambooHR, Rippling, Gusto, Deel, Remote and Employes do payroll; pay-run UX; complaints; pricing; lessons |
| [staffing.md](staffing.md) | Pay/bill modelling in staffing software, NL uitzend rules (CAO 2026–2028, gelijkwaardige beloning, G-rekening, Wtta), US staffing (overtime across assignments, worksite taxes, ACA), and the WeldHR data model for rate cards, timesheets, charges, invoices and margin |

## The rules in brief

### Netherlands

- **What payroll calculates.** Loonheffingen are wage tax, national insurance,
  employee insurance (AWf, Aof, Whk) and the Zvw employer levy. They come from
  published tables and calculation rules.
- **How it's filed.** The loonaangifte is a monthly (or 4-weekly) XML return
  sent through Logius Digipoort with a PKIoverheid certificate. Getting
  connected takes 3–4 months.
- **No certification.** There is no software certification or keurmerk. The
  Belastingdienst publishes the specs, schemas and calculation rules for free.
- **Rules change constantly.** Each tax year brings four to five spec
  releases. The minimum wage changes every 1 January and 1 July, and
  retroactive changes happen.
- **CAOs and pension funds multiply the work.** Generally binding (AVV) CAOs
  and mandatory sector pension funds apply to every employer in the sector.
  Each fund has its own pension return (UPA).
- **The employer stays liable, and payroll software doesn't hold money.** The
  employer remains responsible for the return even when software sends it.
  The software produces a SEPA salary batch and the tax payment, and the
  employer pays both from its own bank.
- **Staffing has its own rules.** It falls under the ABU/NBBU CAO with equal
  pay ("gelijkwaardige beloning") since 1 January 2026, the StiPP pension
  fund, G-rekening invoicing, and the Wtta licensing regime, enforced from
  1 January 2028.

### United States

- **What payroll calculates.** Federal withholding (Pub 15-T), Social Security
  and Medicare (FICA), and federal unemployment tax (FUTA, with credit
  reductions). On top come state income tax, state unemployment tax (SUI) and
  thirteen states plus DC with disability or paid-leave programs. Local taxes
  depend on home and work address. That adds up to about 7,000 taxing
  jurisdictions.
- **Deposits and returns.** Deposits are made monthly or semiweekly through
  EFTPS. Returns are the 941 (quarterly) and 940 (annual), W-2s go through the
  SSA, and each state has its own quarterly wage reports.
- **New W-2 boxes for tax year 2026** (from the One Big Beautiful Bill Act):
  qualified overtime in box 12 code TT, tips (TP), employer Trump-account
  contributions (TA) and a tipped occupation code (box 14b). Code TT needs FLSA
  workweeks and the FLSA overtime premium.
- **Wage and hour.** FLSA overtime is per workweek across all of a worker's
  assignments, plus state daily overtime (California). Each state also has its
  own pay-frequency, final-pay and pay-stub rules.
- **Filing for employers.** Doing it as a reporting agent requires an IRS
  e-file application whose officers are US citizens or green-card holders.
- **Moving money.** Moving payroll funds raises state money-transmission
  questions. Some states (Delaware, Maryland, Nevada) exempt payroll
  processors acting as the employer's agent.

## Open items that decide the plan

These are the unverified points with the most effect on
[the plan](../weldhr-payroll.md):

1. **Check and Gusto Embedded's partner terms:**
   - Do they contract with a non-US platform that has no US subsidiary?
   - Wholesale prices and minimums.
   - Loss allocation.

   (us-providers.md §3)
2. **Partner programmes:**
   - Loket's partner programme and its fees.
   - Whether Employes accepts a software company as a reseller or on its
     accountancy plan.
   - Remote's terms for Dutch payroll depth.

   (nl-providers.md §2, §3)
3. Which Dutch sector pension funds and AVV'd CAOs cover the most SMB
   employees, to order an own engine's CAO roadmap (nl-rules.md §10.5).
4. Whether Easyflex's hours import is enough for an agency export, and who
   owns Easyflex (nl-providers.md, staffing.md).
5. The US money-transmission position needs US counsel. It matters only if
   WeldSuite ever moves US payroll funds itself, which the plan rules out
   (us-rules.md §7).
