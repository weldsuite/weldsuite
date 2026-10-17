import { describe, it, expect } from 'vitest';
import {
  brAdapter,
  brTaxCategoriesFor,
  buildPixPayload,
  cnpjCheckDigits,
  computeBrDocumentTaxes,
  crc16Ccitt,
  icmsRateForSale,
  interstateIcmsRate,
  pixQrSvg,
  validateCnpj,
  validateCnpjOrCpf,
  validateCpf,
  validateInscricaoEstadual,
} from './index';
import type { DocumentTaxContext, DocumentTaxLineInput } from '../types';
import { getAdapter, getJurisdictionFeatures, listJurisdictions } from '../registry';

describe('BR registration numbers', () => {
  it('validates a numeric CNPJ and prints it with its mask', () => {
    expect(validateCnpj('11222333000181')).toEqual({ valid: true, formatted: '11.222.333/0001-81' });
    expect(validateCnpj('11.222.333/0001-82').valid).toBe(false);
  });

  it('validates the alphanumeric CNPJ (RFB example 12.ABC.345/01DE-35)', () => {
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
    expect(validateCnpj('12.abc.345/01de-35')).toEqual({ valid: true, formatted: '12.ABC.345/01DE-35' });
    expect(validateCnpj('12ABC34501DE36').valid).toBe(false);
  });

  it('refuses repeated digits and wrong lengths', () => {
    expect(validateCnpj('00000000000000').valid).toBe(false);
    expect(validateCnpj('1122233300018').valid).toBe(false);
  });

  it('validates a CPF', () => {
    expect(validateCpf('529.982.247-25')).toEqual({ valid: true, formatted: '529.982.247-25' });
    expect(validateCpf('11144477735').valid).toBe(true);
    expect(validateCpf('529.982.247-26').valid).toBe(false);
    expect(validateCpf('111.111.111-11').valid).toBe(false);
  });

  it('tells a CPF from a CNPJ', () => {
    expect(validateCnpjOrCpf('52998224725').kind).toBe('cpf');
    expect(validateCnpjOrCpf('11.222.333/0001-81').kind).toBe('cnpj');
  });

  it('accepts ISENTO as an Inscrição Estadual', () => {
    expect(validateInscricaoEstadual('isento')).toEqual({ valid: true, formatted: 'ISENTO' });
    expect(validateInscricaoEstadual('110.042.490.114').formatted).toBe('110042490114');
    expect(validateInscricaoEstadual('ABC').valid).toBe(false);
  });

  it('routes identifiers through the adapter', () => {
    expect(brAdapter.validateTaxIdentifier('vatNumber', '11222333000181').valid).toBe(true);
    expect(brAdapter.validateTaxIdentifier('registrationNumber', 'ISENTO').valid).toBe(true);
  });
});

describe('BR adapter registration', () => {
  it('is registered with its features and terminology', () => {
    expect(getAdapter('br')).toBe(brAdapter);
    expect(getJurisdictionFeatures('BR')).toMatchObject({ brTaxReturn: true, fiscalDocuments: true, spedEcd: true, vatReturn: false });
    const summary = listJurisdictions().find((j) => j.code === 'BR');
    expect(summary).toMatchObject({ defaultLocale: 'pt-BR', defaultCurrency: 'BRL' });
    expect(summary?.terminology).toMatchObject({ tax: 'tributos', taxId: 'cnpj', registrationId: 'ie' });
  });

  it('seeds the profiles of the regime switched on and the rest off', () => {
    const simples = brTaxCategoriesFor('simples_nacional');
    expect(simples.find((t) => t.isDefault)?.name).toMatch(/Anexo III/);
    expect(simples.filter((t) => t.isActive).every((t) => /Simples|Isento|sem crédito/.test(t.name))).toBe(true);
    const presumido = brAdapter.getStandardTaxCategories({ taxClassification: 'lucro_presumido' });
    expect(presumido.find((t) => t.isDefault)?.name).toBe('Serviço — ISS 5% + PIS/COFINS');
    expect(presumido.find((t) => t.name.startsWith('Simples'))?.isActive).toBe(false);
  });

  it('has an account for every role the engine posts to', () => {
    const roles = new Set(brAdapter.getChartOfAccountsTemplate().map((a) => a.systemRole).filter(Boolean));
    for (const role of [
      'accounts_receivable', 'accounts_payable', 'sales_revenue', 'retained_earnings',
      'tax_payable_iss', 'tax_payable_icms', 'tax_payable_ipi', 'tax_payable_pis', 'tax_payable_cofins', 'tax_payable_simples',
      'revenue_deduction_iss', 'revenue_deduction_icms', 'revenue_deduction_pis', 'revenue_deduction_cofins', 'revenue_deduction_simples',
      'tax_recoverable_icms', 'tax_recoverable_ipi', 'tax_recoverable_pis', 'tax_recoverable_cofins',
      'withheld_receivable_irrf', 'withheld_receivable_pis', 'withheld_receivable_cofins', 'withheld_receivable_csll', 'withheld_receivable_inss',
      'withholding_payable_irrf', 'withholding_payable_csrf', 'withholding_payable_inss', 'withholding_payable_iss',
      'tax_payable_irpj', 'tax_payable_csll', 'income_tax_expense', 'social_contribution_expense',
    ]) {
      expect(roles.has(role as never), role).toBe(true);
    }
  });
});

describe('ICMS rates', () => {
  it('uses the internal rate inside a state', () => {
    expect(icmsRateForSale({ originUf: 'SP', destinationUf: 'SP' })).toEqual({ rate: 18, interstate: false, fcp: 0 });
    expect(icmsRateForSale({ originUf: 'RJ', destinationUf: 'RJ' })).toEqual({ rate: 20, interstate: false, fcp: 2 });
  });

  it('applies 7% from the South/Southeast to the North, Northeast, Center-West and ES, else 12%', () => {
    expect(interstateIcmsRate('SP', 'BA')).toBe(7);
    expect(interstateIcmsRate('SP', 'ES')).toBe(7);
    expect(interstateIcmsRate('ES', 'SP')).toBe(12);
    expect(interstateIcmsRate('SP', 'RJ')).toBe(12);
    expect(interstateIcmsRate('BA', 'SP')).toBe(12);
  });

  it('applies 4% to imported goods', () => {
    expect(interstateIcmsRate('SP', 'BA', '1')).toBe(4);
    expect(interstateIcmsRate('SP', 'BA', '6')).toBe(7);
  });
});

function line(over: Partial<DocumentTaxLineInput> & { profile: Record<string, unknown> }): DocumentTaxLineInput {
  const { profile, ...rest } = over;
  return {
    lineTotal: 1000,
    taxRateId: 'txr_1',
    taxRateName: 'Profile',
    taxCategoryCode: 'standard',
    rate: 0,
    jurisdictionMetadata: { br: profile },
    ...rest,
  };
}

const service = { profile: 'servico_iss_5', regimes: ['lucro_presumido'], kind: 'service', issRate: 5 };
const goods = { profile: 'venda_producao', regimes: ['lucro_presumido'], kind: 'goods_production' };

function ctx(over: Partial<DocumentTaxContext> = {}): DocumentTaxContext {
  return {
    direction: 'sales',
    issueDate: '2026-10-15',
    entitySettings: { uf: 'SP' },
    entityTaxClassification: 'lucro_presumido',
    counterparty: { country: 'BR', stateCode: 'SP', taxId: '11222333000181' },
    ...over,
  };
}

describe('BR document taxes', () => {
  it('puts ISS, PIS and COFINS inside the price of a Lucro Presumido service, with CBS/IBS informational in 2026', () => {
    const result = computeBrDocumentTaxes([line({ profile: service })], ctx());
    const rows = result.lines[0].rows;
    expect(rows.map((r) => [r.component, r.treatment, r.taxAmount])).toEqual([
      ['iss', 'embedded', 50],
      ['pis', 'embedded', 6.5],
      ['cofins', 'embedded', 30],
      // base 1000 - 50 - 6.50 - 30 = 913.50
      ['cbs', 'informational', 8.22],
      ['ibs', 'informational', 0.91],
    ]);
    expect(rows[0]).toMatchObject({ accountRole: 'tax_payable_iss', offsetAccountRole: 'revenue_deduction_iss' });
  });

  it('itemises nothing for the Simples Nacional', () => {
    const result = computeBrDocumentTaxes([line({ profile: { ...service, regimes: ['simples_nacional'], simplesAnexo: 'III' } })], ctx({ entityTaxClassification: 'simples_nacional' }));
    expect(result.lines[0].rows).toEqual([]);
  });

  it('adds IPI on top and takes ICMS at the interstate rate, PIS/COFINS on the base without ICMS', () => {
    const result = computeBrDocumentTaxes(
      [line({ profile: goods, fiscalData: { ipiRate: 10 } })],
      ctx({ counterparty: { country: 'BR', stateCode: 'BA', taxId: '11222333000181' } }),
    );
    const byComponent = Object.fromEntries(result.lines[0].rows.map((r) => [r.component, r]));
    expect(byComponent.ipi).toMatchObject({ treatment: 'added', taxAmount: 100 });
    // Buyer is an ICMS taxpayer (CNPJ): IPI stays out of the ICMS base.
    expect(byComponent.icms).toMatchObject({ treatment: 'embedded', taxRate: 7, taxableAmount: 1000, taxAmount: 70 });
    expect(byComponent.pis.taxableAmount).toBe(930);
  });

  it('includes IPI in the ICMS base for a final consumer and warns about DIFAL across states', () => {
    const result = computeBrDocumentTaxes(
      [line({ profile: goods, fiscalData: { ipiRate: 10 } })],
      ctx({ counterparty: { country: 'BR', stateCode: 'BA', taxId: '52998224725' } }),
    );
    const icms = result.lines[0].rows.find((r) => r.component === 'icms');
    expect(icms?.taxableAmount).toBe(1100);
    expect(result.warnings.some((w) => w.includes('DIFAL'))).toBe(true);
  });

  it('taxes nothing on an export', () => {
    const result = computeBrDocumentTaxes([line({ profile: service })], ctx({ counterparty: { country: 'US' } }));
    expect(result.lines[0].rows).toEqual([]);
  });

  it('withholds IRRF and CSRF on the services of the document', () => {
    const result = computeBrDocumentTaxes(
      [line({ profile: service })],
      ctx({ documentFiscal: { withholdings: { irrf: 1.5, csrf: true, iss: 5 } } }),
    );
    expect(result.documentRows.map((r) => [r.component, r.taxAmount, r.accountRole])).toEqual([
      ['iss_ret', 50, 'tax_payable_iss'],
      ['irrf', 15, 'withheld_receivable_irrf'],
      ['pis_ret', 6.5, 'withheld_receivable_pis'],
      ['cofins_ret', 30, 'withheld_receivable_cofins'],
      ['csll_ret', 10, 'withheld_receivable_csll'],
    ]);
  });

  it('skips withholdings of R$ 10 or less and those that do not apply to a Simples provider', () => {
    const small = computeBrDocumentTaxes([line({ profile: service, lineTotal: 500 })], ctx({ documentFiscal: { withholdings: { irrf: 1.5 } } }));
    expect(small.documentRows).toEqual([]);
    expect(small.warnings[0]).toMatch(/not withheld/);
    const simples = computeBrDocumentTaxes(
      [line({ profile: { ...service, regimes: ['simples_nacional'] } })],
      ctx({ entityTaxClassification: 'simples_nacional', documentFiscal: { withholdings: { irrf: 1.5, csrf: true, iss: 2 } } }),
    );
    expect(simples.documentRows.map((r) => [r.component, r.accountRole])).toEqual([['iss_ret', 'revenue_deduction_iss']]);
  });

  it('books withholdings on a purchase as payables, and credits ICMS and PIS/COFINS for Lucro Real', () => {
    const purchase = { profile: 'compra_revenda_credito', regimes: ['lucro_real'], kind: 'goods_resale', credits: { icms: true, pisCofins: true } };
    const result = computeBrDocumentTaxes(
      [line({ profile: purchase })],
      ctx({ direction: 'purchase', entityTaxClassification: 'lucro_real', counterparty: { country: 'BR', stateCode: 'SP' } }),
    );
    expect(result.lines[0].rows.map((r) => [r.component, r.treatment, r.taxAmount, r.accountRole])).toEqual([
      ['icms', 'embedded', 180, 'tax_recoverable_icms'],
      ['pis', 'embedded', 13.53, 'tax_recoverable_pis'],
      ['cofins', 'embedded', 62.32, 'tax_recoverable_cofins'],
    ]);
  });

  it('drops PIS/COFINS from 2027 and asks for the CBS rate', () => {
    const result = computeBrDocumentTaxes([line({ profile: service })], ctx({ issueDate: '2027-02-01' }));
    expect(result.lines[0].rows.map((r) => r.component)).toEqual(['iss']);
    expect(result.warnings.some((w) => w.includes('CBS'))).toBe(true);
  });
});

describe('Pix BR Code', () => {
  it('reproduces the BACEN example payload and CRC', () => {
    const payload = buildPixPayload({
      key: '123e4567-e12b-12d1-a456-426655440000',
      merchantName: 'Fulano de Tal',
      merchantCity: 'BRASILIA',
    });
    expect(payload).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    );
    expect(crc16Ccitt(payload.slice(0, -4))).toBe('1D3D');
  });

  it('adds the amount and a reference', () => {
    const payload = buildPixPayload({ key: '11222333000181', merchantName: 'Empresa Ação', merchantCity: 'São Paulo', amount: 1234.5, txid: 'INV-000123' });
    expect(payload).toContain('54071234.50');
    expect(payload).toContain('5912Empresa Acao');
    expect(payload).toContain('6009Sao Paulo');
    expect(payload).toContain('62130509INV000123');
  });

  it('renders a QR code as SVG', () => {
    expect(pixQrSvg('test')).toMatch(/^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  });
});
