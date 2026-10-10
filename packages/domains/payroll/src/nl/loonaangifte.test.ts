/**
 * The loonaangifte for a realistic employer (fixtures/employer-scenario.ts).
 * The same XML was validated against the official Loonaangifte2026v2.0.xsd
 * and Loonaangifte2027v2.0.xsd with a JAXP schema validator during
 * development; these tests pin the element order of that schema and check
 * that the totals reconcile with the payslips.
 */
import { describe, expect, it } from 'vitest';
import type { NlFilingData } from '../types';
import { calculateNlPayslip } from './calculate';
import { annaInput, loonaangifteInput, scenario } from './fixtures/employer-scenario';
import {
  betalingskenmerk,
  buildLoonaangifte,
  isValidBsn,
  isValidLoonheffingennummer,
  loonaangifteDueDate,
  loonaangifteSummaryDocument,
  sumNlFilingData,
  type LoonaangifteInput,
} from './loonaangifte';

/** Child element names of the first `<name>` element (direct children only). */
function childNames(xml: string, name: string, occurrence = 0): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'g');
  let match: RegExpExecArray | null = null;
  for (let i = 0; i <= occurrence; i += 1) match = re.exec(xml);
  if (!match) return [];
  let depth = 0;
  const out: string[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w]*)[^>]*?(\/?)>/g;
  tagRe.lastIndex = match.index + match[0].length;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(xml))) {
    const [, close, tag] = t;
    if (close) {
      if (depth === 0) break;
      depth -= 1;
    } else {
      if (depth === 0) out.push(tag!);
      depth += 1;
    }
  }
  return out;
}

const valueOf = (xml: string, tag: string, occurrence = 0) => {
  const all = [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  return all[occurrence]?.[1];
};

function input(): LoonaangifteInput {
  const i = loonaangifteInput();
  // The March return as originally filed (without the bonus): its TotTeBet is the saldo base.
  const s = scenario();
  const original = buildLoonaangifte({
    ...i,
    period: { start: '2026-03-01', end: '2026-03-31' },
    ikvs: [
      { ...i.corrections[0]!.ikvs[0]!, filing: s.anna[2]!.filingData as NlFilingData },
      { ...i.corrections[0]!.ikvs[1]! },
    ],
    corrections: [],
  });
  i.corrections[0]!.previouslyReportedTotTeBetCents = original.summary.TotTeBet!;
  return i;
}

describe('loonaangifte April 2026: regular employee, DGA and a starter, with a March correction', () => {
  const s = scenario();
  const inp = input();
  const r = buildLoonaangifte(inp);
  const xml = r.file.content;

  it('builds without issues', () => {
    expect(r.issues).toEqual([]);
    expect(r.file).toMatchObject({ fileName: 'loonaangifte-001234560L01-2026-04.xml', contentType: 'application/xml' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Loonaangifte xmlns="http://xml.belastingdienst.nl/schemas/Loonaangifte/2026/01" version="2.0">')).toBe(true);
  });

  it('follows the XSD element order', () => {
    expect(childNames(xml, 'Loonaangifte')).toEqual(['Bericht', 'AdministratieveEenheid']);
    expect(childNames(xml, 'Bericht')).toEqual(['IdBer', 'DatTdAanm', 'ContPers', 'TelNr', 'RelNr', 'GebrSwPakket']);
    expect(childNames(xml, 'AdministratieveEenheid')).toEqual(['LhNr', 'NmIP', 'TijdvakAangifte', 'TijdvakCorrectie']);
    expect(childNames(xml, 'TijdvakAangifte')).toEqual(['DatAanvTv', 'DatEindTv', 'VolledigeAangifte']);
    expect(childNames(xml, 'VolledigeAangifte')).toEqual(['CollectieveAangifte', 'InkomstenverhoudingInitieel', 'InkomstenverhoudingInitieel', 'InkomstenverhoudingInitieel']);
    expect(childNames(xml, 'CollectieveAangifte')).toEqual([
      'TotLnLbPh', 'TotLnSV', 'TotPrlnAofAnwLg', 'TotPrlnAofAnwHg', 'TotPrlnAofAnwUit', 'TotPrlnWhkAnw', 'TotPrlnAwfAnwLg',
      'TotPrlnAwfAnwHg', 'TotPrlnAwfAnwHz', 'TotPrlnAwfAnwUit', 'PrLnUFO', 'IngLbPh', 'TotPrAofLg', 'TotOpslWko', 'TotPrGediffWhk',
      'TotPrAwfLg', 'TotPrAwfHg', 'IngBijdrZvw', 'TotWghZvw', 'TotTeBet', 'SaldoCorrectiesVoorgaandTijdvak', 'TotGen',
    ]);
    expect(childNames(xml, 'InkomstenverhoudingInitieel')).toEqual(['NumIV', 'DatAanv', 'PersNr', 'NatuurlijkPersoon', 'Inkomstenperiode', 'Werknemersgegevens', 'Sector']);
    expect(childNames(xml, 'NatuurlijkPersoon')).toEqual(['SofiNr', 'Voorl', 'Voorv', 'SignNm', 'Gebdat', 'Nat', 'Gesl', 'AdresBinnenland']);
    expect(childNames(xml, 'AdresBinnenland')).toEqual(['Str', 'HuisNr', 'HuisNrToev', 'Pc', 'Woonpl']);
    expect(childNames(xml, 'Inkomstenperiode')).toEqual([
      'DatAanv', 'SrtIV', 'CdAard', 'CAO', 'IndArbovOnbepTd', 'IndSchriftArbov', 'IndOprov', 'IndLhKort', 'LbTab', 'IndWAO', 'IndWW', 'IndZW', 'CdZvw',
    ]);
    expect(childNames(xml, 'Werknemersgegevens')).toEqual([
      'LnLbPh', 'LnSV', 'PrlnAofAnwLg', 'PrlnAofAnwHg', 'PrlnAofAnwUit', 'PrlnWhkAnw', 'PrlnAwfAnwLg', 'PrlnAwfAnwHg', 'PrlnAwfAnwHz',
      'PrlnAwfAnwUit', 'PrLnUfo', 'LnTabBB', 'VakBsl', 'OpgRchtVakBsl', 'OpnAvwb', 'OpbAvwb', 'LnInGld', 'WrdLn', 'LnOwrk', 'VerstrAanv',
      'IngLbPh', 'PrAofLg', 'PrAofHg', 'PrAofUit', 'OpslWko', 'PrGediffWhk', 'PrAwfLg', 'PrAwfHg', 'PrAwfHz', 'PrAwfUit', 'PrUFO',
      'BijdrZvw', 'WghZvw', 'WrdPrGebrAut', 'WrknBijdrAut', 'Reisk', 'VerrArbKrt', 'AantVerlU', 'Ctrctln', 'AantCtrcturenPWk', 'BedrRntKstvPersl',
    ]);
    expect(childNames(xml, 'Sector')).toEqual(['DatAanvSect', 'Sect']);
    expect(childNames(xml, 'TijdvakCorrectie')).toEqual(['DatAanvTv', 'DatEindTv', 'CollectieveAangifte', 'InkomstenverhoudingInitieel', 'InkomstenverhoudingInitieel']);
  });

  it('collective totals reconcile with the payslips (sum of unrounded amounts, then whole euros)', () => {
    const april = [s.anna[3]!, s.dga[3]!, s.starter].map((p) => p.filingData as NlFilingData);
    const sum = (k: keyof NlFilingData['amounts']) => april.reduce((t, f) => t + (f.amounts[k] ?? 0), 0);
    expect(Number(valueOf(xml, 'TotLnLbPh'))).toBe(Math.trunc(sum('loonLbPh') / 100));
    expect(Number(valueOf(xml, 'TotLnSV'))).toBe(Math.trunc(sum('loonSv') / 100));
    expect(Number(valueOf(xml, 'IngLbPh'))).toBe(Math.trunc(sum('wageTax') / 100));
    expect(Number(valueOf(xml, 'TotWghZvw'))).toBe(Math.trunc(sum('zvwEmployerLevy') / 100));
    expect(Number(valueOf(xml, 'IngBijdrZvw'))).toBe(Math.trunc(sum('zvwWithheld') / 100));
    const payable = ['IngLbPh', 'TotPrAofLg', 'TotOpslWko', 'TotPrGediffWhk', 'TotPrAwfLg', 'TotPrAwfHg', 'IngBijdrZvw', 'TotWghZvw'];
    const totTeBet = payable.reduce((t, k) => t + Number(valueOf(xml, k)), 0);
    expect(Number(valueOf(xml, 'TotTeBet'))).toBe(totTeBet);
    expect(r.summary.TotTeBet).toBe(totTeBet * 100);
    // TotGen = TotTeBet + saldo of the March correction (GS condition 0011).
    expect(Number(valueOf(xml, 'TotGen'))).toBe(totTeBet + Number(valueOf(xml, 'Saldo')));
    expect(r.amountDueCents).toBe(Number(valueOf(xml, 'TotGen')) * 100);
  });

  it('reports the March correction with its saldo against the March return as filed', () => {
    // The forgotten € 500 bonus: wage tax 37,56% + 4,45% offset on 4.924,80 × 12 … = row 45.593: 50,47%.
    const extraTax = Math.floor(50_000 * 0.5047);
    expect(Number(valueOf(xml, 'Saldo'))).toBeGreaterThanOrEqual(Math.trunc(extraTax / 100) - 1);
    expect(xml).toContain('<TijdvakCorrectie>\n      <DatAanvTv>2026-03-01</DatAanvTv>');
  });

  it('writes the DGA as inkomenscode 17 with the withheld Zvw contribution and no employee insurances', () => {
    const dgaIkv = xml.split('<InkomstenverhoudingInitieel>')[2]!;
    expect(dgaIkv).toContain('<SrtIV>17</SrtIV>');
    expect(dgaIkv).not.toContain('<CdAard>');
    expect(dgaIkv).not.toContain('<IndArbovOnbepTd>');
    expect(dgaIkv).toContain('<IndWAO>N</IndWAO>');
    expect(dgaIkv).toContain('<CdZvw>M</CdZvw>');
    expect(dgaIkv).toContain('<LnSV>0</LnSV>');
    expect(dgaIkv).not.toContain('<Sector>');
    expect(dgaIkv).toMatch(/<WrdPrGebrAut>[1-9]/);
  });

  it('writes the starter with the day table, a fixed-term contract (AWf high) and the start date', () => {
    const starterIkv = xml.split('<InkomstenverhoudingInitieel>')[3]!;
    expect(starterIkv).toContain('<DatAanv>2026-04-13</DatAanv>');
    expect(starterIkv).toContain('<LbTab>015</LbTab>');
    expect(starterIkv).toContain('<IndArbovOnbepTd>N</IndArbovOnbepTd>');
    expect(starterIkv).toMatch(/<PrlnAwfAnwHg>[1-9]/);
    expect(starterIkv).toContain('<Nat>0339</Nat>');
    expect(starterIkv).toContain('<SignNm>Öztürk</SignNm>');
  });

  it('prints a summary', () => {
    const doc = loonaangifteSummaryDocument(r, inp, 'nl');
    expect(doc.title).toBe('Aangifte loonheffingen');
    const fields = doc.sections[0]!.kind === 'fields' ? doc.sections[0]!.fields : [];
    expect(fields.find((f) => f.label === 'Betalingskenmerk')?.value).toBe(betalingskenmerk({ loonheffingennummer: '001234560L01', taxYear: 2026, month: 4 }));
    expect(fields.find((f) => f.label === 'Uiterste aangifte- en betaaldatum')?.value).toBe('2026-05-31');
    expect(loonaangifteSummaryDocument(r, inp, 'en').title).toBe('Payroll tax return');
  });
});

describe('special cases', () => {
  it('splits the income period at the AOW date', () => {
    const p = calculateNlPayslip({ ...annaInput(4, { x: 1 }), employee: { dateOfBirth: '1959-04-16', startDate: '2023-02-01', endDate: null } });
    const inp = input();
    inp.ikvs = [{ ...inp.ikvs[0]!, identity: { ...inp.ikvs[0]!.identity, dateOfBirth: '1959-04-16' }, filing: p.filingData as NlFilingData }];
    inp.corrections = [];
    const xml = buildLoonaangifte(inp).file.content;
    const periods = [...xml.matchAll(/<Inkomstenperiode>[\s\S]*?<\/Inkomstenperiode>/g)].map((m) => m[0]);
    expect(periods).toHaveLength(2);
    expect(periods[1]).toContain('<DatAanv>2026-04-16</DatAanv>');
    expect(periods[1]).toContain('<IndWW>N</IndWW>');
    expect(periods[1]).toContain('<IndZW>J</IndZW>');
  });

  it('puts a transitievergoeding in its own income relationship (inkomenscode 62, green table)', () => {
    const p = calculateNlPayslip({ ...annaInput(4, { x: 1 }), employee: { dateOfBirth: '1988-09-12', startDate: '2023-02-01', endDate: '2026-04-30' }, inputs: [{ code: 'nl.transition_payment', label: null, quantity: null, rate: null, amountCents: 600_000, workDate: null }] });
    const inp = input();
    inp.corrections = [];
    inp.ikvs = [{ ...inp.ikvs[0]!, employmentEnd: '2026-04-30', endReasonCode: '04', filing: p.filingData as NlFilingData }];
    const missing = buildLoonaangifte(inp);
    expect(missing.issues.map((i) => i.code)).toContain('missing_income_relationship_number');
    inp.ikvs[0]!.transitionPaymentIncomeRelationshipNumber = 2;
    const r = buildLoonaangifte(inp);
    expect(r.issues).toEqual([]);
    const ikvs = r.file.content.split('<InkomstenverhoudingInitieel>').slice(1);
    expect(ikvs).toHaveLength(2);
    expect(ikvs[0]).toContain('<CdRdnEindArbov>04</CdRdnEindArbov>');
    expect(ikvs[1]).toContain('<SrtIV>62</SrtIV>');
    expect(ikvs[1]).toContain('<LbTab>020</LbTab>');
    expect(ikvs[1]).toContain('<LnLbPh>6000</LnLbPh>');
    expect(ikvs[1]).toContain('<LnSV>0</LnSV>');
    // Loon LB/PH of both together equals the payslip.
    const lnlb = [...r.file.content.matchAll(/<LnLbPh>([^<]*)<\/LnLbPh>/g)].map((m) => Number(m[1]));
    expect(Math.round((lnlb[0]! + lnlb[1]!) * 100)).toBe((p.filingData as NlFilingData).amounts.loonLbPh);
  });

  it('reports invalid or missing data as issues', () => {
    const inp = input();
    inp.employer.loonheffingennummer = '123456789L01';
    inp.software.relationNumber = null;
    inp.ikvs[0]!.identity = { ...inp.ikvs[0]!.identity, bsn: '123456789' };
    inp.ikvs[1]!.identity = { ...inp.ikvs[1]!.identity, address: null };
    inp.corrections[0]!.previouslyReportedTotTeBetCents = null;
    const codes = buildLoonaangifte(inp).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['invalid_loonheffingennummer', 'missing_software_relation_number', 'invalid_bsn', 'missing_address', 'correction_saldo_unknown']));
  });

  it('defaults a missing end reason to 99 with a warning', () => {
    const inp = input();
    inp.corrections = [];
    inp.ikvs = [{ ...inp.ikvs[0]!, employmentEnd: '2026-04-20' }];
    const r = buildLoonaangifte(inp);
    expect(r.file.content).toContain('<CdRdnEindArbov>99</CdRdnEindArbov>');
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'end_reason_defaulted', params: { incomeRelationship: 1 } });
  });

  it('sums several payslips of one income relationship', () => {
    const a = scenario().anna;
    const f = sumNlFilingData([a[2]!.filingData as NlFilingData, a[3]!.filingData as NlFilingData]);
    expect(f.amounts.loonLbPh).toBe((a[2]!.filingData as NlFilingData).amounts.loonLbPh + (a[3]!.filingData as NlFilingData).amounts.loonLbPh);
    expect(f.hoursPaid).toBe(346);
  });
});

describe('validation helpers', () => {
  it('BSN elfproef and the first-digit rule', () => {
    expect(isValidBsn('111222333')).toBe(true);
    expect(isValidBsn('11222333')).toBe(false);
    expect(isValidBsn('012345678')).toBe(false); // elfproef fails
    expect(isValidBsn('12312319')).toBe(true); // 8 digits: leading zero (GS condition 0356)
    expect(isValidBsn('999999990')).toBe(false); // starts with 9
    expect(isValidBsn(null)).toBe(false);
  });

  it('loonheffingennummer', () => {
    expect(isValidLoonheffingennummer('001234560L01')).toBe(true);
    expect(isValidLoonheffingennummer('001234560L00')).toBe(false);
    expect(isValidLoonheffingennummer('001234561L01')).toBe(false);
    expect(isValidLoonheffingennummer('001234560B01')).toBe(false);
  });
});

describe('betalingskenmerk (Specificatie Betalingskenmerk v1.0, test set Loonaangifte)', () => {
  it.each([
    ['001000275L01', 2006, 1, '8001000276601010'],
    ['001000287L02', 2007, 2, '9001000286702020'],
    ['001000299L03', 2007, 3, '8001000296703030'],
    ['001000305L04', 2007, 4, '9001000306704040'],
    ['001000317L05', 2007, 5, '8001000316705050'],
    ['001000329L06', 2006, 6, '5001000326606060'],
    ['001000330L07', 2006, 7, '4001000336607070'],
    ['001000342L08', 2006, 8, '3001000346608080'],
    ['001000354L09', 2006, 9, '2001000356609090'],
    ['001000366L10', 2007, 10, '9001000366710100'],
    ['001000378L11', 2007, 11, '8001000376711110'],
    ['001000391L12', 2007, 12, '4001000396712120'],
  ])('%s %i-%i → %s', (lhnr, year, month, expected) => {
    expect(betalingskenmerk({ loonheffingennummer: lhnr, taxYear: year, month })).toBe(expected);
  });

  it('rejects an invalid number or month', () => {
    expect(betalingskenmerk({ loonheffingennummer: 'x', taxYear: 2026, month: 1 })).toBeNull();
    expect(betalingskenmerk({ loonheffingennummer: '001234560L01', taxYear: 2026, month: 13 })).toBeNull();
  });
});

describe('due dates (TijdvakCodesAangifteBetaalDatums 2026 and 2027)', () => {
  it.each([
    [2026, 1, '2026-02-28'],
    [2026, 3, '2026-04-30'],
    [2026, 11, '2026-12-31'],
    [2026, 12, '2027-01-31'],
    [2027, 1, '2027-02-28'],
    [2027, 12, '2028-01-31'],
  ])('%i-%i → %s', (year, month, due) => {
    expect(loonaangifteDueDate(year, month)).toBe(due);
  });
});
