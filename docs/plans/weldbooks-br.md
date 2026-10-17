# WeldBooks Brazil (BR)

Brazilian accounting in WeldBooks: the `BR` jurisdiction adapter, a document
tax engine for taxes with different bases and treatments, the monthly tax
worksheet (apuração), electronic fiscal documents through Focus NFe, Pix on
invoices and the SPED ECD export.

Reference material, with sources: [tax-research.md](weldbooks-br/tax-research.md)
(Simples Nacional tables, ICMS rates, regimes, withholdings, CBS/IBS, CNPJ,
ECD layout, Pix) and [focusnfe-api.md](weldbooks-br/focusnfe-api.md).

## Scope decisions (Oct 2026)

| Question | Decision |
|---|---|
| Regimes | All four (MEI, Simples Nacional, Lucro Presumido, Lucro Real); Simples and Presumido fully calculated. Lucro Real: correct bookkeeping and PIS/COFINS credits, IRPJ/CSLL on book profit without LALUR. |
| Goods vs services | Services first (ISS, withholdings, NFS-e). Goods basic: ICMS (internal / interstate 4-7-12%), IPI, NCM/CFOP per line. No ICMS-ST, no DIFAL calculation (warned). |
| Fiscal documents | Through Focus NFe (NF-e, NFS-e Nacional / municipal, NF-e received + manifestação), behind `services/br-fiscal`. |
| Language | pt-BR locale for WeldBooks; invoices print in Portuguese (entity locale `pt-BR`). |

## Model

- **Regime** = `entities.tax_classification` (`mei | simples_nacional | lucro_presumido | lucro_real`), legal form = `entities.entity_type` (`mei | ei | slu | ltda | sa`). Changing the regime switches the seeded tax profiles on/off.
- **Settings** = `entities.jurisdiction_settings` (`BrEntitySettings`: UF, IBGE municipality, IM, CNAE, default ISS rate, Pix key, CBS/IBS rates from 2027, fiscal provider settings). PATCH merges.
- **Tax profiles**: a BR tax rate is a recipe (`tax_rates.jurisdiction_metadata.br`: kind of supply, Simples annex, ISS rate, purchase credits); its `rate` is 0.
- **Document fiscal data**: `invoice_items/bill_items.ncm, cfop, fiscal_data` (rate overrides, origin, LC 116 item); `invoices/bills.fiscal_data` (withholdings, final consumer, buyer ICMS status). Counterparty flags: `parties.br_fiscal`.
- **Treatments** on `tax_breakdown` rows (`DocumentTaxBreakdownRow.treatment`): `added` (IPI; CBS/IBS from 2027) is part of the total; `embedded` (ISS, ICMS, FCP, PIS, COFINS) is inside the price; `withheld` (IRRF, CSRF, INSS, ISS retido) comes off the total; `informational` (CBS/IBS 2026). So `total` = subtotal + added − withheld = what the counterparty owes; `taxTotal` = added − withheld.

## Posting

| Row | Invoice | Bill |
|---|---|---|
| added | Cr payable | Dr recoverable (or into the line's cost when not creditable) |
| embedded | Dr revenue deduction / Cr payable | Dr recoverable, taken out of the line's cost (creditable only) |
| withheld | Dr receivable (a compensar), or Dr ISS payable / ISS deduction | Cr withholding payable |
| informational | tax ledger only | — |

The adapter hook `computeDocumentTaxes` (jurisdictions/types.ts) does the
whole document at once; books-api calls it from `calculateRateTableTax` for
any jurisdiction that has it.

## Apuração (`/api/br-tax/apuracao`)

Simples: DAS per annex (RBT12, fator R, ISS cap, ISS withheld and exports
excluded); MEI: fixed DAS-MEI. Presumido/Real: ISS, ICMS, IPI, PIS, COFINS
(debits − credits − customer withholdings), quarterly IRPJ/CSLL (LC 224/2025
uplift above R$ 1.25 M a quarter). Every regime: withholdings to pay over
(DARF 1708 / 5952). Booking posts the DAS, IRPJ/CSLL and the withholding
offsets and keeps the worksheet in `tax_returns` (jurisdiction BR).

## Not done / follow-ups

- ICMS-ST, DIFAL / FCP per NCM, Inscrição Estadual check digits per state.
- 2027: CBS reference rate (Senate, Dec 2026) and the new Simples annexes with CBS/IBS; until then CBS/IBS rates are entity settings.
- EFD-Contribuições / EFD ICMS-IPI / ECF; the referential chart mapping (I051) is left to the contador in the PGE.
- Boleto (needs a bank partner).
