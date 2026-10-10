/**
 * A realistic small employer for the filing tests: a regular employee, a DGA
 * and a starter who joined mid-month, paid for April 2026, plus a correction
 * of March for the regular employee. Payslips come from the real engine.
 * The BSNs are made-up numbers that pass the elfproef.
 */
import type { NlPayslipInput } from '../../types';
import { calculateNlPayslip } from '../calculate';
import type { LoonaangifteInput } from '../loonaangifte';

export function period(month: number) {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  return { start: `2026-${mm}-01`, end: `2026-${mm}-${last}`, payDate: `2026-${mm}-24`, frequency: 'monthly' as const, taxYear: 2026, periodNumber: month, periodsPerYear: 12 };
}

const employer: NlPayslipInput['employer'] = { whkRatePercent: null, sectorCode: 43, aofSmallEmployer: true, holidayAllowancePercent: 8, holidayAllowancePayoutMonth: 5 };

const baseNl: NlPayslipInput['nl'] = {
  applyLoonheffingskorting: true, anonymous: false, isDga: false, insuredWw: true, insuredZw: true, insuredWao: true,
  writtenContract: true, indefiniteContract: true, onCall: false, contractHoursPerWeek: 40, expatRulingPercent: null,
  previousYearAnnualWageCents: 4_924_800,
};

export function annaInput(month: number, ytd: Record<string, number>, bonusCents = 0): NlPayslipInput {
  return {
    country: 'NL', period: period(month), employer, ytd,
    employee: { dateOfBirth: '1988-09-12', startDate: '2023-02-01', endDate: null },
    compensation: { payType: 'salary', amount: 3800, period: 'month', hoursPerWeek: 40 },
    components: [{ code: 'nl.travel_allowance', amountCents: null, params: { km_per_day: 30, days_per_month: 18 } }],
    inputs: bonusCents ? [{ code: 'bonus', label: null, quantity: null, rate: null, amountCents: bonusCents, workDate: null }] : [],
    nl: baseNl,
  };
}

export function dgaInput(month: number, ytd: Record<string, number>): NlPayslipInput {
  return {
    country: 'NL', period: period(month), employer, ytd,
    employee: { dateOfBirth: '1975-03-02', startDate: '2020-01-01', endDate: null },
    compensation: { payType: 'salary', amount: 60000, period: 'year', hoursPerWeek: 40 },
    components: [{ code: 'nl.company_car', amountCents: null, params: { list_price: 52000, percent: 22, zero_emission_cap: 30000, zero_emission_percent: 18 } }],
    inputs: [],
    nl: { ...baseNl, isDga: true, insuredWw: false, insuredZw: false, insuredWao: false, previousYearAnnualWageCents: 7_100_000 },
  };
}

export function starterInput(): NlPayslipInput {
  return {
    country: 'NL', period: period(4), employer, ytd: {},
    employee: { dateOfBirth: '2001-11-30', startDate: '2026-04-13', endDate: null },
    compensation: { payType: 'salary', amount: 3200, period: 'month', hoursPerWeek: 40 },
    components: [], inputs: [],
    nl: { ...baseNl, indefiniteContract: false, previousYearAnnualWageCents: null },
  };
}

/** January–April for Anna and the DGA (YTD carried), April for the starter, and Anna's corrected March. */
export function scenario() {
  let annaYtd: Record<string, number> = {};
  let dgaYtd: Record<string, number> = {};
  const anna: ReturnType<typeof calculateNlPayslip>[] = [];
  const dga: ReturnType<typeof calculateNlPayslip>[] = [];
  for (let m = 1; m <= 4; m += 1) {
    const a = calculateNlPayslip(annaInput(m, annaYtd));
    const d = calculateNlPayslip(dgaInput(m, dgaYtd));
    anna.push(a);
    dga.push(d);
    annaYtd = a.ytd;
    dgaYtd = d.ytd;
  }
  const starter = calculateNlPayslip(starterInput());
  // March corrected: a € 500 bonus was forgotten (recomputed on February's YTD).
  const annaMarchCorrected = calculateNlPayslip(annaInput(3, anna[1]!.ytd, 50_000));
  return { anna, dga, starter, annaMarchCorrected };
}

export const ANNA_IDENTITY = {
  bsn: '111222333', initials: 'A.M.', surnamePrefix: 'de', surname: 'Vries', dateOfBirth: '1988-09-12', nationality: 'NL', gender: 2 as const,
  address: { street: 'Keizersgracht', houseNumber: '123', houseNumberAddition: 'B', postalCode: '1015 CJ', city: 'Amsterdam', country: 'NL' },
  personnelNumber: 'E001',
};
export const DGA_IDENTITY = {
  bsn: '123456782', initials: 'P', surnamePrefix: null, surname: 'Jansen', dateOfBirth: '1975-03-02', nationality: 'NL', gender: 1 as const,
  address: { street: 'Dorpsstraat', houseNumber: '7', postalCode: '3511AB', city: 'Utrecht', country: 'NL' },
  personnelNumber: 'E002',
};
export const STARTER_IDENTITY = {
  bsn: '232262536', initials: 'S', surnamePrefix: null, surname: 'Öztürk', dateOfBirth: '2001-11-30', nationality: 'TR', gender: 0 as const,
  address: { street: 'Lange Nieuwstraat', houseNumber: '45', postalCode: '3512 PH', city: 'Utrecht', country: 'NL' },
  personnelNumber: 'E003',
};

export function loonaangifteInput(): LoonaangifteInput {
  const s = scenario();
  const nlFiling = (r: ReturnType<typeof calculateNlPayslip>) => {
    if (r.filingData.kind !== 'nl') throw new Error('expected NL filing data');
    return r.filingData;
  };
  return {
    employer: { loonheffingennummer: '001234560L01', name: 'Voorbeeld B.V.', contactName: 'J. Bakker', contactPhone: '020-1234567', sectorCode: 43 },
    software: { name: 'WeldSuite', version: '1.0', relationNumber: 'SWO12345' },
    taxYear: 2026,
    period: { start: '2026-04-01', end: '2026-04-30' },
    ikvs: [
      { identity: ANNA_IDENTITY, incomeRelationshipNumber: 1, employmentStart: '2023-02-01', employmentEnd: null, filing: nlFiling(s.anna[3]!) },
      { identity: DGA_IDENTITY, incomeRelationshipNumber: 1, employmentStart: '2020-01-01', employmentEnd: null, filing: nlFiling(s.dga[3]!) },
      { identity: STARTER_IDENTITY, incomeRelationshipNumber: 1, employmentStart: '2026-04-13', employmentEnd: null, filing: nlFiling(s.starter) },
    ],
    corrections: [
      {
        period: { start: '2026-03-01', end: '2026-03-31' },
        ikvs: [
          { identity: ANNA_IDENTITY, incomeRelationshipNumber: 1, employmentStart: '2023-02-01', employmentEnd: null, filing: nlFiling(s.annaMarchCorrected) },
          { identity: DGA_IDENTITY, incomeRelationshipNumber: 1, employmentStart: '2020-01-01', employmentEnd: null, filing: nlFiling(s.dga[2]!) },
        ],
        previouslyReportedTotTeBetCents: 0, // set by the test from the original March return
      },
    ],
    createdAt: '2026-05-08T10:15:00Z',
    messageId: '001234560L01-2026-04-1',
  };
}
