import { describe, expect, it } from 'vitest';

import { betalingskenmerk } from './nl/loonaangifte';
import {
  BELASTINGDIENST_ACCOUNTS,
  PAIN_001_NAMESPACE,
  belastingdienstAccount,
  buildSepaSalaryBatch,
  isValidBetalingskenmerk,
  isValidIban,
  toSepaText,
  type SepaSalaryBatchInput,
} from './sepa';

const kenmerk = betalingskenmerk({ loonheffingennummer: '001234560L01', taxYear: 2026, month: 7 })!;

function input(overrides: Partial<SepaSalaryBatchInput> = {}): SepaSalaryBatchInput {
  return {
    messageId: 'SAL-prun_8f3k2',
    createdAt: '2026-08-20T09:30:00.000Z',
    executionDate: '2026-08-25',
    debtor: { name: 'Voorbeeld B.V.', iban: 'NL91 ABNA 0417 1643 00', bic: 'ABNANL2A' },
    salaries: [
      {
        endToEndId: 'pslip_a1',
        creditor: { name: 'Anna de Vries', iban: 'NL04RABO0200112244', bic: null },
        amountCents: 254_312,
        remittance: 'Salaris augustus 2026',
      },
      {
        endToEndId: 'pslip_b2',
        creditor: { name: 'Zoë Müller & Søn <Holding>', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
        amountCents: 1,
        remittance: 'Salaris augustus 2026',
      },
    ],
    tax: { amountCents: 123_456, betalingskenmerk: kenmerk },
    ...overrides,
  };
}

/** The text of the n-th occurrence of an element. */
function text(xml: string, tag: string, n = 0): string | undefined {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))][n]?.[1];
}

describe('isValidIban', () => {
  it('accepts valid IBANs, with spaces and in lower case', () => {
    expect(isValidIban('NL91ABNA0417164300')).toBe(true);
    expect(isValidIban('nl91 abna 0417 1643 00')).toBe(true);
    expect(isValidIban(BELASTINGDIENST_ACCOUNTS.ing.iban)).toBe(true);
    expect(isValidIban(BELASTINGDIENST_ACCOUNTS.rabobank.iban)).toBe(true);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('BE68539007547034')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });

  it('rejects a wrong check digit, a wrong Dutch layout and garbage', () => {
    expect(isValidIban('NL92ABNA0417164300')).toBe(false);
    expect(isValidIban('NL91ABNA041716430')).toBe(false);
    expect(isValidIban('NL91AB1A0417164300')).toBe(false);
    expect(isValidIban('DE89370400440532013001')).toBe(false);
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('0417164300')).toBe(false);
    expect(isValidIban('NL91-ABNA-0417-1643-00')).toBe(false);
  });
});

describe('isValidBetalingskenmerk', () => {
  it('accepts every generated monthly reference', () => {
    for (let month = 1; month <= 12; month += 1) {
      const ref = betalingskenmerk({ loonheffingennummer: '001234560L01', taxYear: 2026, month })!;
      expect(isValidBetalingskenmerk(ref)).toBe(true);
    }
    expect(isValidBetalingskenmerk(`${kenmerk.slice(0, 4)} ${kenmerk.slice(4, 8)} ${kenmerk.slice(8, 12)} ${kenmerk.slice(12)}`)).toBe(true);
  });

  it('rejects a changed digit and a wrong length', () => {
    const changed = `${kenmerk.slice(0, 5)}${(Number(kenmerk[5]) + 1) % 10}${kenmerk.slice(6)}`;
    expect(isValidBetalingskenmerk(changed)).toBe(false);
    expect(isValidBetalingskenmerk(kenmerk.slice(1))).toBe(false);
    expect(isValidBetalingskenmerk(`${kenmerk}0`)).toBe(false);
  });
});

describe('toSepaText', () => {
  it('keeps the EPC basic Latin set and transliterates the rest', () => {
    expect(toSepaText('Zoë Müller & Søn <Holding>', 70)).toBe('Zoe Muller + Son Holding');
    expect(toSepaText("O'Neil (ref: 12/3) ?+,.-", 70)).toBe("O'Neil (ref: 12/3) ?+,.-");
    expect(toSepaText('x'.repeat(200), 140)).toHaveLength(140);
  });
});

describe('belastingdienstAccount', () => {
  it('switches to the Rabobank account from 1 May 2026', () => {
    expect(belastingdienstAccount('2026-04-30').iban).toBe('NL86INGB0002445588');
    expect(belastingdienstAccount('2026-05-01').iban).toBe('NL04RABO0200112244');
    expect(belastingdienstAccount('2027-01-31').iban).toBe('NL04RABO0200112244');
  });
});

describe('buildSepaSalaryBatch', () => {
  it('builds a pain.001.001.09 file with a SALA batch and a separate TAXS payment', () => {
    const file = buildSepaSalaryBatch(input());
    const xml = file.content;
    expect(file.issues).toEqual([]);
    expect(file.contentType).toBe('application/xml');
    expect(file.fileName).toBe('salarissen-2026-08-25-SAL-prun-8f3k2.xml');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain(`<Document xmlns="${PAIN_001_NAMESPACE}">`);

    // Group header: all transactions and the overall control sum.
    expect(text(xml, 'MsgId')).toBe('SAL-prun-8f3k2');
    expect(text(xml, 'CreDtTm')).toBe('2026-08-20T09:30:00');
    expect(text(xml, 'NbOfTxs', 0)).toBe('3');
    expect(text(xml, 'CtrlSum', 0)).toBe('3777.69');

    // Salary batch.
    expect(text(xml, 'PmtInfId', 0)).toBe('SAL-prun-8f3k2-SAL');
    expect(text(xml, 'BtchBookg', 0)).toBe('true');
    expect(text(xml, 'NbOfTxs', 1)).toBe('2');
    expect(text(xml, 'CtrlSum', 1)).toBe('2543.13');
    expect(xml).toMatch(/<CtgyPurp>\s*<Cd>SALA<\/Cd>/);
    expect(text(xml, 'PmtMtd')).toBe('TRF');
    expect(text(xml, 'ChrgBr')).toBe('SLEV');
    expect(text(xml, 'Dt')).toBe('2026-08-25');
    expect(text(xml, 'BICFI', 0)).toBe('ABNANL2A');
    expect(text(xml, 'EndToEndId', 0)).toBe('pslip-a1');
    expect(xml).toContain('<InstdAmt Ccy="EUR">2543.12</InstdAmt>');
    expect(xml).toContain('<InstdAmt Ccy="EUR">0.01</InstdAmt>');
    expect(xml).toContain('<Nm>Zoe Muller + Son Holding</Nm>');
    expect(xml).toContain('<IBAN>NL91ABNA0417164300</IBAN>');
    expect(text(xml, 'Ustrd')).toBe('Salaris augustus 2026');

    // Tax payment: its own payment information, structured reference.
    expect(text(xml, 'PmtInfId', 1)).toBe('SAL-prun-8f3k2-TAX');
    expect(text(xml, 'BtchBookg', 1)).toBe('false');
    expect(text(xml, 'CtrlSum', 2)).toBe('1234.56');
    expect(xml).toContain('<Cd>TAXS</Cd>');
    expect(xml).toContain('<Nm>Belastingdienst</Nm>');
    expect(xml).toContain('<IBAN>NL04RABO0200112244</IBAN>');
    expect(text(xml, 'Issr')).toBe('CUR');
    expect(text(xml, 'Ref')).toBe(kenmerk);
    expect(xml).toMatch(/<CdOrPrtry>\s*<Cd>SCOR<\/Cd>\s*<\/CdOrPrtry>\s*<Issr>CUR<\/Issr>\s*<\/Tp>\s*<Ref>\d{16}<\/Ref>/);
    expect(text(xml, 'EndToEndId', 2)).toBe(`SAL-prun-8f3k2-LH${kenmerk.slice(-6)}`);

    // A debtor agent is mandatory: NOTPROVIDED without a BIC; no creditor agent without one.
    const noBic = buildSepaSalaryBatch(input({ debtor: { name: 'Voorbeeld B.V.', iban: 'NL91ABNA0417164300' } })).content;
    expect(noBic).toMatch(/<DbtrAgt>\s*<FinInstnId>\s*<Othr>\s*<Id>NOTPROVIDED<\/Id>/);
    expect(noBic.match(/<CdtrAgt>/g)).toHaveLength(1);
  });

  it('is deterministic and contains no unescaped markup from the input', () => {
    const a = buildSepaSalaryBatch(input()).content;
    expect(buildSepaSalaryBatch(input()).content).toBe(a);
    expect(a).not.toMatch(/<Holding>|&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('leaves the tax out when there is none', () => {
    const xml = buildSepaSalaryBatch(input({ tax: null })).content;
    expect(xml).not.toContain('TAXS');
    expect(xml.match(/<PmtInf>/g)).toHaveLength(1);
    expect(text(xml, 'NbOfTxs', 0)).toBe('2');
    expect(text(xml, 'CtrlSum', 0)).toBe('2543.13');
  });

  it('pays the tax alone (no salaries) and uses the ING account before May 2026', () => {
    const file = buildSepaSalaryBatch(input({ executionDate: '2026-04-28', salaries: [] }));
    expect(file.issues).toEqual([]);
    expect(file.content).toContain('<IBAN>NL86INGB0002445588</IBAN>');
    expect(file.content).not.toContain('SALA');
    expect(text(file.content, 'NbOfTxs', 0)).toBe('1');
  });

  it('flags the ING account for 2027 payments', () => {
    const file = buildSepaSalaryBatch(
      input({ executionDate: '2027-01-25', tax: { amountCents: 100, betalingskenmerk: kenmerk, creditor: { ...BELASTINGDIENST_ACCOUNTS.ing } } }),
    );
    expect(file.issues).toContainEqual({ severity: 'error', code: 'outdated_tax_account', params: { iban: 'NL86INGB0002445588' } });
  });

  it('reports bad accounts, amounts and references, naming the payment', () => {
    const base = input();
    const file = buildSepaSalaryBatch({
      ...base,
      debtor: { name: '   ', iban: 'NL00ABNA0417164300', bic: 'NOPE' },
      salaries: [
        { ...base.salaries[0]!, creditor: { name: 'A', iban: 'NL91ABNA0417164301' } },
        { ...base.salaries[1]!, endToEndId: 'pslip_a1', amountCents: 0 },
        { ...base.salaries[1]!, endToEndId: 'pslip_c3', amountCents: 10.5 },
        { ...base.salaries[1]!, endToEndId: '//', amountCents: 100 },
      ],
      tax: { amountCents: -5, betalingskenmerk: '1234' },
    });
    const codes = file.issues.map((i) => i.code);
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_iban', params: { role: 'debtor' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_bic', params: { role: 'debtor' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'missing_account_holder', params: { role: 'debtor' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_iban', params: { role: 'employee', endToEndId: 'pslip_a1' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'duplicate_end_to_end_id', params: { endToEndId: 'pslip_a1' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_amount', params: { endToEndId: 'pslip_a1', amountCents: 0 } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_amount', params: { endToEndId: 'pslip_c3', amountCents: 10.5 } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_end_to_end_id', params: { endToEndId: '//' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_betalingskenmerk', params: { betalingskenmerk: '1234' } });
    expect(file.issues).toContainEqual({ severity: 'error', code: 'invalid_amount', params: { endToEndId: 'tax', amountCents: -5 } });
    expect(codes.every((c) => typeof c === 'string')).toBe(true);
    // Rejected payments stay out of the control sums.
    expect(text(file.content, 'CtrlSum', 0)).toBe('2543.12');
  });

  it('warns when the payee bank is in a non-EEA SEPA country (payer address needed)', () => {
    const base = input();
    const file = buildSepaSalaryBatch({
      ...base,
      tax: null,
      salaries: [{ ...base.salaries[0]!, creditor: { name: 'Sam Smith', iban: 'GB82WEST12345698765432' } }],
    });
    expect(file.issues).toEqual([{ severity: 'warning', code: 'non_eea_creditor', params: { endToEndId: 'pslip_a1', country: 'GB' } }]);
    expect(file.content).toContain('<IBAN>GB82WEST12345698765432</IBAN>');
  });

  it('reports an empty batch, a bad date and a bad timestamp', () => {
    const file = buildSepaSalaryBatch(input({ salaries: [], tax: null, executionDate: '25-08-2026', createdAt: '2026-08-20' }));
    expect(file.issues.map((i) => i.code).sort()).toEqual(['empty_batch', 'invalid_created_at', 'invalid_execution_date']);
  });

  it('sanitises identifiers: no leading or trailing slash, no double slash, max 35', () => {
    const file = buildSepaSalaryBatch(input({ messageId: `/run//${'9'.repeat(60)}/` }));
    const msgId = text(file.content, 'MsgId')!;
    expect(msgId.length).toBeLessThanOrEqual(35);
    expect(msgId.startsWith('/')).toBe(false);
    expect(msgId.endsWith('/')).toBe(false);
    expect(msgId).not.toContain('//');
    for (const id of [...file.content.matchAll(/<(?:PmtInfId|EndToEndId)>([^<]*)</g)].map((m) => m[1]!)) {
      expect(id.length).toBeLessThanOrEqual(35);
    }
  });

  it('formats large amounts with two decimals and no separators', () => {
    const file = buildSepaSalaryBatch(input({ salaries: [{ ...input().salaries[0]!, amountCents: 99_999_999_999 }], tax: null }));
    expect(file.issues).toEqual([]);
    expect(file.content).toContain('<InstdAmt Ccy="EUR">999999999.99</InstdAmt>');
    expect(text(file.content, 'CtrlSum', 0)).toBe('999999999.99');
  });
});
