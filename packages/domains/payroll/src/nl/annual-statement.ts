/**
 * The jaaropgaaf: the employee's annual statement (Handboek Loonheffingen
 * 2026 [HB] §15).
 *
 * The statement is form-free (HB §15.2) but must show at least (HB §15.3,
 * and the numbered boxes of the Belastingdienst's "Model jaaropgaaf vanaf
 * 2022", LH 012-1Z*3PL in the ODB release LH2026v09):
 * employee name and BSN, employer name, and
 *   1 loon voor de loonbelasting/volksverzekeringen (loonstaat column 14),
 *   2 ingehouden loonbelasting/premie volksverzekeringen (column 15),
 *   3 verrekende arbeidskorting (column 18),
 *   4 ingehouden bijdrage Zvw (column 16),
 *   5 totaal premies werknemersverzekeringen paid for the employee,
 *   6 werkgeversheffing Zvw.
 * The amounts are the year's final payslips added up (each payslip's
 * `filingData` holds exactly the figures the return carried).
 */

import type { PayrollDocument } from '../documents';
import { fromCents } from '../money';
import type { NlFilingData } from '../types';

export interface NlAnnualStatementInput {
  lang: 'en' | 'nl';
  year: number;
  employer: { name: string; loonheffingennummer: string | null; address: string[] };
  employee: {
    name: string;
    bsn: string | null;
    dateOfBirth: string | null;
    address: string[];
    employmentStart: string | null;
    employmentEnd: string | null;
    personnelNumber: string | null;
  };
  /** The year's final payslips, oldest first. */
  payslips: Array<{ payDate: string; filingData: NlFilingData; ytd: Record<string, number> }>;
}

export interface NlAnnualTotals {
  loonLbPh: number;
  wageTax: number;
  labourCredit: number;
  zvwWithheld: number;
  employeeInsurancePremiums: number;
  zvwEmployerLevy: number;
  /** Not required, shown for information. */
  loonSv: number;
  holidayAllowancePaid: number;
  companyCarValue: number;
  companyCarEmployeeContribution: number;
  pensionEmployee: number;
  hoursPaid: number;
}

/** The year's figures from the payslips' filing data. */
export function nlAnnualTotals(payslips: NlAnnualStatementInput['payslips']): NlAnnualTotals {
  const t: NlAnnualTotals = {
    loonLbPh: 0, wageTax: 0, labourCredit: 0, zvwWithheld: 0, employeeInsurancePremiums: 0, zvwEmployerLevy: 0,
    loonSv: 0, holidayAllowancePaid: 0, companyCarValue: 0, companyCarEmployeeContribution: 0, pensionEmployee: 0, hoursPaid: 0,
  };
  for (const p of payslips) {
    const a = p.filingData.amounts;
    t.loonLbPh += a.loonLbPh;
    t.wageTax += a.wageTax;
    t.labourCredit += a.labourCredit;
    t.zvwWithheld += a.zvwWithheld;
    // Box 5: AWf, Aof (including the Wko surcharge) and Whk paid for this employee (HB §15.3).
    t.employeeInsurancePremiums += a.awfPremium + a.aofPremium + a.wkoPremium + a.whkPremium;
    t.zvwEmployerLevy += a.zvwEmployerLevy;
    t.loonSv += a.loonSv;
    t.holidayAllowancePaid += a.holidayAllowancePaid;
    t.companyCarValue += a.companyCarValue;
    t.companyCarEmployeeContribution += a.companyCarEmployeeContribution;
    t.pensionEmployee += a.pensionEmployee;
    t.hoursPaid += p.filingData.hoursPaid;
  }
  return t;
}

function money(cents: number, lang: 'en' | 'nl'): string {
  const [whole, dec] = fromCents(Math.abs(cents)).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'nl' ? '.' : ',');
  return `${cents < 0 ? '-' : ''}€ ${grouped}${lang === 'nl' ? ',' : '.'}${dec}`;
}

function formatBsn(bsn: string | null): string {
  if (!bsn) return '—';
  const d = bsn.replace(/\D/g, '').padStart(9, '0');
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
}

export function nlAnnualStatement(input: NlAnnualStatementInput): PayrollDocument {
  const { lang } = input;
  const nl = lang === 'nl';
  const t = nlAnnualTotals(input.payslips);
  const m = (c: number) => money(c, lang);

  const employment = [input.employee.employmentStart, input.employee.employmentEnd].some(Boolean)
    ? `${input.employee.employmentStart ?? '…'} – ${input.employee.employmentEnd ?? (nl ? 'heden' : 'present')}`
    : '—';

  return {
    title: nl ? `Jaaropgaaf ${input.year}` : `Annual statement ${input.year}`,
    subtitle: nl ? 'Opgaaf van loon en ingehouden loonheffingen' : 'Statement of wages and payroll taxes withheld',
    language: lang,
    from: [input.employer.name, ...input.employer.address, ...(input.employer.loonheffingennummer ? [`${nl ? 'Loonheffingennummer' : 'Payroll tax number'}: ${input.employer.loonheffingennummer}`] : [])],
    to: [input.employee.name, ...input.employee.address],
    sections: [
      {
        kind: 'fields',
        title: nl ? 'Gegevens werknemer' : 'Employee',
        fields: [
          { label: nl ? 'Naam' : 'Name', value: input.employee.name },
          { label: nl ? 'Burgerservicenummer' : 'Citizen service number (BSN)', value: formatBsn(input.employee.bsn) },
          ...(input.employee.dateOfBirth ? [{ label: nl ? 'Geboortedatum' : 'Date of birth', value: input.employee.dateOfBirth }] : []),
          ...(input.employee.personnelNumber ? [{ label: nl ? 'Personeelsnummer' : 'Personnel number', value: input.employee.personnelNumber }] : []),
          { label: nl ? 'Periode in dienst' : 'Employment', value: employment },
        ],
      },
      {
        kind: 'fields',
        title: nl ? 'Gegevens werkgever' : 'Employer',
        fields: [{ label: nl ? 'Naam' : 'Name', value: input.employer.name }],
      },
      {
        kind: 'fields',
        title: nl ? `Bedragen ${input.year}` : `Amounts ${input.year}`,
        fields: [
          { label: nl ? '1 Loon voor de loonbelasting/volksverzekeringen' : '1 Wage for wage tax and national insurance', value: m(t.loonLbPh), emphasis: true },
          { label: nl ? '2 Ingehouden loonbelasting/premie volksverzekeringen (loonheffing)' : '2 Wage tax and national insurance withheld', value: m(t.wageTax), emphasis: true },
          { label: nl ? '3 Verrekende arbeidskorting' : '3 Labour tax credit applied', value: m(t.labourCredit) },
          { label: nl ? '4 Ingehouden bijdrage Zorgverzekeringswet' : '4 Health insurance contribution withheld (Zvw)', value: m(t.zvwWithheld) },
          { label: nl ? '5 Totaal premies werknemersverzekeringen' : '5 Employee insurance premiums paid by the employer', value: m(t.employeeInsurancePremiums) },
          { label: nl ? '6 Werkgeversheffing Zorgverzekeringswet' : '6 Employer health insurance levy (Zvw)', value: m(t.zvwEmployerLevy) },
        ],
      },
      {
        kind: 'table',
        title: nl ? 'Ter informatie' : 'For information',
        columns: [nl ? 'Omschrijving' : 'Item', nl ? 'Bedrag' : 'Amount'],
        alignRight: [1],
        rows: [
          [nl ? 'Loon werknemersverzekeringen (SV-loon)' : 'Wage for employee insurances', m(t.loonSv)],
          [nl ? 'Uitbetaald vakantiegeld' : 'Holiday allowance paid', m(t.holidayAllowancePaid)],
          [nl ? 'Pensioenpremie werknemer' : 'Employee pension contribution', m(t.pensionEmployee)],
          [nl ? 'Bijtelling auto van de zaak' : 'Company car taxable benefit', m(t.companyCarValue)],
          [nl ? 'Eigen bijdrage auto van de zaak' : 'Own contribution company car', m(t.companyCarEmployeeContribution)],
          [nl ? 'Verloonde uren' : 'Hours paid', String(t.hoursPaid)],
        ],
      },
      {
        kind: 'text',
        title: nl ? 'Toelichting' : 'Notes',
        paragraphs: nl
          ? [
              'Het loon onder 1 is het loon waarover loonheffing is ingehouden. Dit bedrag en de ingehouden loonheffing onder 2 geeft u op in uw aangifte inkomstenbelasting.',
              'De verrekende arbeidskorting onder 3 is de arbeidskorting die met uw maandloon is verrekend. De premies onder 5 en de werkgeversheffing onder 6 heeft uw werkgever betaald; ze zijn niet op uw loon ingehouden.',
              'Kloppen deze gegevens niet? Neem dan contact op met uw werkgever.',
            ]
          : [
              'Box 1 is the wage on which wage tax was withheld. Report it, with the tax withheld in box 2, in your Dutch income tax return.',
              'Box 3 is the labour tax credit applied with your monthly pay. The premiums in box 5 and the levy in box 6 were paid by your employer and not withheld from your pay.',
              'If anything is wrong, contact your employer.',
            ],
      },
    ],
    footer: [nl ? `Jaaropgaaf ${input.year}` : `Annual statement ${input.year} (jaaropgaaf)`],
    watermark: null,
  };
}
