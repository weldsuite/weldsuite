import {
  allowedBrRegimes,
  cnpjCheckDigits,
  cnpjProblem,
  formatCnpj,
  formatCnpjInput,
  normalizeCnpj,
  validBrRegime,
} from '@/lib/br';
import {
  groupByTreatment,
  hasTreatmentRows,
  treatmentTotals,
} from '@/lib/tax-treatment';
import type { TaxBreakdownRow } from '@/types/accounting';

describe('CNPJ', () => {
  it('strips the mask and upper-cases', () => {
    expect(normalizeCnpj('11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizeCnpj(' ab.cde.fgh/0001-xx ')).toBe('ABCDEFGH0001XX');
  });

  it('computes the two check digits over the ASCII value minus 48', () => {
    expect(cnpjCheckDigits('112223330001')).toBe('81');
    // Letters count as 17..42 since July 2026.
    const first12 = '12ABC34501DE';
    const full = `${first12}${cnpjCheckDigits(first12)}`;
    expect(cnpjProblem(full)).toBeNull();
  });

  it('accepts a valid numeric CNPJ, masked or not', () => {
    expect(cnpjProblem('11.222.333/0001-81')).toBeNull();
    expect(cnpjProblem('11222333000181')).toBeNull();
  });

  it('flags the wrong shape and wrong check digits', () => {
    expect(cnpjProblem('1122233300018')).toBe('format');
    expect(cnpjProblem('11222333000180')).toBe('checkDigits');
    expect(cnpjProblem('00000000000000')).toBe('format');
    expect(cnpjProblem('112223330001AB')).toBe('format');
  });

  it('has nothing to say about an empty field', () => {
    expect(cnpjProblem('')).toBeNull();
    expect(cnpjProblem('  ')).toBeNull();
  });

  it('masks a complete CNPJ while typing and leaves a partial one alone', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpjInput('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpjInput('11.222.333')).toBe('11222333');
    expect(formatCnpjInput('ab12cd34ef560001991')).toBe('AB.12C.D34/EF56-00');
  });
});

describe('Brazilian tax regimes', () => {
  it('lets only a MEI be in the SIMEI and keeps an S.A. out of the Simples', () => {
    expect(allowedBrRegimes('mei')).toEqual(['mei']);
    expect(allowedBrRegimes('sa')).toEqual(['lucro_presumido', 'lucro_real']);
    expect(allowedBrRegimes('ltda')).toEqual(['simples_nacional', 'lucro_presumido', 'lucro_real']);
  });

  it('keeps a regime the legal form allows and otherwise falls back to the default', () => {
    expect(validBrRegime('ltda', 'lucro_real')).toBe('lucro_real');
    expect(validBrRegime('ltda', 'mei')).toBe('simples_nacional');
    expect(validBrRegime('mei', 'lucro_real')).toBe('mei');
    expect(validBrRegime('sa', 'simples_nacional')).toBe('lucro_presumido');
    expect(validBrRegime('ltda', undefined)).toBe('simples_nacional');
  });
});

describe('tax treatment grouping', () => {
  const rows: TaxBreakdownRow[] = [
    { taxRateName: 'ICMS', component: 'icms', taxRate: 18, taxableAmount: 1000, taxAmount: 180, treatment: 'embedded' },
    { taxRateName: 'ICMS', component: 'icms', taxRate: 18, taxableAmount: 500, taxAmount: 90, treatment: 'embedded' },
    { taxRateName: 'IPI', component: 'ipi', taxRate: 5, taxableAmount: 1500, taxAmount: 75, treatment: 'added' },
    { taxRateName: 'IRRF', component: 'irrf', taxRate: 1.5, taxableAmount: 1500, taxAmount: 22.5, treatment: 'withheld' },
    { taxRateName: 'INSS retido', component: 'inss_ret', taxRate: 11, taxableAmount: 1500, taxAmount: -165, treatment: 'withheld' },
    { taxRateName: 'CBS', component: 'cbs', taxRate: 0.9, taxableAmount: 1500, taxAmount: 13.5, treatment: 'informational' },
  ];

  it('knows a document that carries treatments from one that does not', () => {
    expect(hasTreatmentRows(rows)).toBe(true);
    expect(hasTreatmentRows([{ taxRateName: 'VAT 21%', taxRate: 21, taxAmount: 21 }])).toBe(false);
    expect(hasTreatmentRows(undefined)).toBe(false);
    expect(hasTreatmentRows([])).toBe(false);
  });

  it('groups in display order and sums a tax over its lines', () => {
    const groups = groupByTreatment(rows);

    expect(groups.map((group) => group.treatment)).toEqual(['added', 'embedded', 'withheld', 'informational']);
    expect(groups[1].taxes).toHaveLength(1);
    expect(groups[1].taxes[0]).toMatchObject({ name: 'ICMS', rate: 18, base: 1500, amount: 270 });
    expect(groups[1].total).toBe(270);
  });

  it('keeps withheld amounts positive whichever sign the server used', () => {
    const withheld = groupByTreatment(rows).find((group) => group.treatment === 'withheld');

    expect(withheld?.taxes.map((tax) => tax.amount)).toEqual([22.5, 165]);
    expect(withheld?.total).toBe(187.5);
  });

  it('splits what is added from what is withheld; embedded and informational rows change nothing', () => {
    expect(treatmentTotals(rows)).toEqual({ added: 75, withheld: 187.5 });
    expect(treatmentTotals([])).toEqual({ added: 0, withheld: 0 });
  });

  it('leaves out rows without a known treatment and skips absent groups', () => {
    const groups = groupByTreatment([
      { taxRateName: 'VAT', taxRate: 21, taxAmount: 21 },
      { taxRateName: 'PIS', component: 'pis', taxRate: 1.65, taxableAmount: 100, taxAmount: 1.65, treatment: 'embedded' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].treatment).toBe('embedded');
  });
});
