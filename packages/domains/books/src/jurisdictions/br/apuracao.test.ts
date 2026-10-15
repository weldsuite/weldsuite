import { describe, it, expect } from 'vitest';
import { annexAfterFatorR, computeSimplesDas, proportionalRbt12, simplesEffectiveRate } from './simples';
import { computeBrApuracao, lc224Excess } from './apuracao';
import { buildEcd } from './ecd';

describe('Simples Nacional', () => {
  it('works out the effective rate of a bracket', () => {
    // Anexo III, faixa 3: (500.000 x 13,5% - 17.640) / 500.000 = 9,972%
    const rate = simplesEffectiveRate('III', 500_000);
    expect(rate.faixa).toBe(3);
    expect(rate.effectiveRate).toBeCloseTo(9.972, 3);
    expect(rate.rateByTax.iss).toBeCloseTo(9.972 * 0.325, 6);
  });

  it('uses the nominal rate of the first bracket', () => {
    expect(simplesEffectiveRate('I', 100_000).effectiveRate).toBeCloseTo(4, 6);
    expect(simplesEffectiveRate('I', 0).effectiveRate).toBe(4);
  });

  it('caps the ISS share at 5% and spreads the excess over the other taxes', () => {
    // Anexo III faixa 5, RBT12 3M: (3.000.000 x 21% - 125.640) / 3.000.000 = 16,812%
    const rate = simplesEffectiveRate('III', 3_000_000);
    expect(rate.effectiveRate).toBeCloseTo(16.812, 3);
    expect(rate.rateByTax.iss).toBe(5);
    // CPP gets 65,26% of the 11,812% left (the law's percentage).
    expect(rate.rateByTax.cpp).toBeCloseTo(11.812 * 0.6526, 2);
    const total = Object.values(rate.rateByTax).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBeCloseTo(16.812, 6);
  });

  it('moves Anexo V activities to Anexo III with a fator R of 28% or more', () => {
    expect(annexAfterFatorR('V', 84_000, 300_000)).toEqual({ anexo: 'III', fatorR: 0.28 });
    expect(annexAfterFatorR('V', 50_000, 300_000).anexo).toBe('V');
    expect(annexAfterFatorR('III', 0, 300_000)).toEqual({ anexo: 'III', fatorR: null });
  });

  it('annualises the revenue of a company in its first year', () => {
    expect(proportionalRbt12({ revenueBefore: 0, monthsBefore: 0, currentMonthRevenue: 10_000 })).toBe(120_000);
    expect(proportionalRbt12({ revenueBefore: 30_000, monthsBefore: 3, currentMonthRevenue: 5_000 })).toBe(120_000);
    expect(proportionalRbt12({ revenueBefore: 400_000, monthsBefore: 12, currentMonthRevenue: 5_000 })).toBe(400_000);
  });

  it('leaves the ISS share out on revenue the customer withheld ISS on, and PIS/COFINS/ISS on exports', () => {
    const das = computeSimplesDas({
      rbt12: 500_000,
      payroll12m: 0,
      slices: [{ anexo: 'III', revenue: 50_000, issWithheld: 10_000, exports: 5_000 }],
    });
    const line = das.lines[0];
    expect(line.faixa).toBe(3);
    const rate = 9.972;
    expect(line.byTax.iss).toBeCloseTo((35_000 * rate * 0.325) / 100, 1);
    expect(line.byTax.irpj).toBeCloseTo((50_000 * rate * 0.04) / 100, 1);
    expect(line.byTax.cofins).toBeCloseTo((45_000 * rate * 0.1364) / 100, 1);
    expect(das.total).toBe(line.amount);
  });
});

describe('Apuração', () => {
  it('works out the DAS of a Simples Nacional month', () => {
    const result = computeBrApuracao({
      period: '2026-09',
      regime: 'simples_nacional',
      simples: { rbt12: 500_000, payroll12m: 0, slices: [{ anexo: 'III', revenue: 50_000 }] },
      ledger: [],
    });
    expect(result.simples?.total).toBeCloseTo(4986, 0);
    expect(result.simples?.dueDate).toBe('2026-10-20');
    expect(result.total).toBe(result.simples?.total);
  });

  it('works out the DAS-MEI of 2026', () => {
    const result = computeBrApuracao({ period: '2026-03', regime: 'mei', meiActivity: 'both', ledger: [] });
    expect(result.mei).toMatchObject({ amount: 87.05, inss: 81.05, icms: 1, iss: 5 });
  });

  it('nets ISS and PIS/COFINS of a Lucro Presumido month and lists what to pay over', () => {
    const result = computeBrApuracao({
      period: '2026-08',
      regime: 'lucro_presumido',
      ledger: [
        { component: 'iss', direction: 'sales', taxableAmount: 10_000, taxAmount: 500 },
        { component: 'iss_ret', direction: 'sales', taxableAmount: 2_000, taxAmount: 100 },
        { component: 'pis', direction: 'sales', taxableAmount: 10_000, taxAmount: 65 },
        { component: 'cofins', direction: 'sales', taxableAmount: 10_000, taxAmount: 300 },
        { component: 'pis_ret', direction: 'sales', taxableAmount: 2_000, taxAmount: 13 },
        { component: 'irrf', direction: 'purchase', taxableAmount: 4_000, taxAmount: 60 },
        { component: 'csll_ret', direction: 'purchase', taxableAmount: 4_000, taxAmount: 40 },
        { component: 'pis_ret', direction: 'purchase', taxableAmount: 4_000, taxAmount: 26 },
        { component: 'cofins_ret', direction: 'purchase', taxableAmount: 4_000, taxAmount: 120 },
      ],
    });
    const byCode = Object.fromEntries(result.taxes.map((t) => [t.code, t]));
    expect(byCode.iss.payable).toBe(400);
    expect(byCode.pis.payable).toBe(52);
    expect(byCode.cofins.payable).toBe(300);
    expect(result.withholdingsToPay).toEqual([
      { code: 'irrf', base: 4_000, amount: 60, dueDate: '2026-09-20', darfCode: '1708' },
      { code: 'csrf', base: 4_000, amount: 186, dueDate: '2026-09-20', darfCode: '5952' },
    ]);
    expect(result.quarterly).toBeNull();
  });

  it('works out IRPJ and CSLL on the presumed profit at the end of a quarter', () => {
    const result = computeBrApuracao({
      period: '2026-03',
      regime: 'lucro_presumido',
      ledger: [{ component: 'irrf', direction: 'sales', taxableAmount: 100_000, taxAmount: 1_500 }],
      quarter: { services: [300_000], goods: [0], otherIncome: 1_000 },
    });
    // 300.000 x 32% + 1.000 = 97.000; IRPJ 15% = 14.550 + 10% over 60.000 = 3.700; CSLL 9% = 8.730
    expect(result.quarterly).toMatchObject({
      quarter: 1,
      irpjBase: 97_000,
      irpj: 14_550,
      irpjAdditional: 3_700,
      csll: 8_730,
      irrfOffset: 1_500,
      irpjPayable: 16_750,
      dueDate: '2026-04-30',
      lc224Applied: false,
    });
  });

  it('applies the LC 224 increase only to revenue above R$ 1.25 million a quarter', () => {
    expect(lc224Excess([1_000_000])).toBe(0);
    expect(lc224Excess([1_500_000])).toBe(250_000);
    // Unused room of Q1 carries into Q2.
    expect(lc224Excess([1_000_000, 1_400_000])).toBe(0);
    expect(lc224Excess([1_000_000, 1_600_000])).toBe(100_000);
    const result = computeBrApuracao({
      period: '2026-03',
      regime: 'lucro_presumido',
      ledger: [],
      quarter: { services: [1_500_000], goods: [0], otherIncome: 0 },
    });
    // 1.250.000 x 32% + 250.000 x 35,2% = 488.000; CSLL not yet in 2026 Q1.
    expect(result.quarterly?.irpjBase).toBe(488_000);
    expect(result.quarterly?.csllBase).toBe(480_000);
    expect(result.quarterly?.lc224Applied).toBe(true);
  });
});

describe('SPED ECD', () => {
  const result = buildEcd({
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    company: { name: 'Empresa Teste Ltda', cnpj: '11.222.333/0001-81', uf: 'SP', municipalityCode: '3550308', municipalityName: 'São Paulo' },
    accounts: [
      { code: '1.1.1.02', name: 'Bancos', type: 'asset' },
      { code: '2.3.3.01', name: 'Lucros acumulados', type: 'equity' },
      { code: '3.1.1.02', name: 'Receita de serviços', type: 'revenue' },
      { code: '4.2.2.99', name: 'Despesas gerais', type: 'expense' },
    ],
    openingBalances: { '1.1.1.02': 1000, '2.3.3.01': -1000 },
    entries: [
      { id: 'JE-1', date: '2025-03-10', description: 'Venda', lines: [{ accountCode: '1.1.1.02', debit: 500, credit: 0 }, { accountCode: '3.1.1.02', debit: 0, credit: 500 }] },
      { id: 'JE-2', date: '2025-04-02', description: 'Despesa', lines: [{ accountCode: '4.2.2.99', debit: 200, credit: 0 }, { accountCode: '1.1.1.02', debit: 0, credit: 200 }] },
    ],
    retainedEarningsCode: '2.3.3.01',
    signatories: [
      { name: 'Contadora', taxId: '52998224725', code: '900', qualification: 'Contador', crc: 'SP123456', crcUf: 'SP', email: 'c@x.com', phone: '11999999999', legalRepresentative: false },
      { name: 'Sócio', taxId: '11144477735', code: '205', qualification: 'Administrador', legalRepresentative: true },
    ],
  });
  const lines = result.content.trim().split('\r\n');

  it('opens and closes with the right registers and counts its lines', () => {
    expect(lines[0]).toBe('|0000|LECD|01012025|31122025|Empresa Teste Ltda|11222333000181|SP||3550308|||0|0|0||0|0||N|N|0|0||');
    expect(lines.at(-1)).toBe(`|9999|${lines.length}|`);
    expect(lines.find((l) => l.startsWith('|I030|'))).toContain(`|${lines.length}|`);
    expect(result.warnings).toEqual([]);
  });

  it('builds the synthetic accounts above the analytical ones', () => {
    expect(lines).toContain('|I050|01012025|01|S|1|1||ATIVO|');
    expect(lines).toContain('|I050|01012025|01|A|4|1.1.1.02|1.1.1|Bancos|');
  });

  it('generates the closing entry and the result balances before it', () => {
    expect(lines.some((l) => /^\|I200\|ENC-2025\|31122025\|500,00\|E\|\|$/.test(l))).toBe(true);
    expect(lines).toContain('|I355|3.1.1.02||500,00|C|');
    expect(lines).toContain('|I355|4.2.2.99||200,00|D|');
    // Retained earnings close at 1.300 credit.
    expect(lines.some((l) => l.startsWith('|J100|2.3.3.01|D|4|2.3.3|P|') && l.endsWith('|1000,00|C|1300,00|C||'))).toBe(true);
  });

  it('counts every register in block 9', () => {
    const counted = lines.filter((l) => l.startsWith('|9900|'));
    const i250 = counted.find((l) => l.startsWith('|9900|I250|'));
    expect(i250).toBe(`|9900|I250|${lines.filter((l) => l.startsWith('|I250|')).length}|`);
    expect(lines.find((l) => l.startsWith('|9900|9900|'))).toBe(`|9900|9900|${counted.length}|`);
  });
});
