import { describe, expect, it } from 'vitest';
import {
  BR_TAX_PROFILES,
  brProfileOf,
  computeBrDocumentTaxes,
  type BrTaxRegime,
} from '@weldsuite/books-domain/jurisdictions/br';
import type { DocumentTaxLineInput } from '@weldsuite/books-domain/jurisdictions/types';
import {
  BrPayloadError,
  buildNfePayload,
  buildNfsePayload,
  buildNfsenPayload,
  chooseFiscalKind,
  HOMOLOGACAO_RECIPIENT_NAME,
  municipalServiceItem,
  nationalServiceCode,
  returnCfop,
  splitStreet,
  type BrFiscalCounterparty,
  type BrFiscalDocument,
  type BrFiscalLine,
  type BrFiscalSettings,
  type BuildPayloadArgs,
} from './payload';

const NOW = new Date('2026-10-15T13:00:00Z');

function profileMetadata(name: string): Record<string, unknown> {
  const template = BR_TAX_PROFILES.find((t) => brProfileOf(t.jurisdictionMetadata)?.profile === name);
  if (!template?.jurisdictionMetadata) throw new Error(`unknown profile ${name}`);
  return template.jurisdictionMetadata;
}

function line(profile: string, overrides: Partial<BrFiscalLine> = {}): BrFiscalLine {
  const kind = brProfileOf(profileMetadata(profile))?.kind;
  return {
    description: 'Produto exemplo',
    quantity: 2,
    unitPrice: 100,
    discountPercent: 0,
    unit: 'un',
    lineTotal: 200,
    ncm: '49111090',
    cfop: null,
    fiscal: {},
    kind,
    ...overrides,
  };
}

const customer: BrFiscalCounterparty = {
  name: 'Cliente Comercial Ltda',
  email: 'compras@cliente.com.br',
  taxId: '99.887.766/0001-55',
  address: { line1: 'Rua das Flores, 123', city: 'Sao Paulo', state: 'SP', postalCode: '01311-000', country: 'BR', county: 'Centro', line2: 'Sala 4' },
  fiscal: { inscricaoEstadual: '140.212.370', icmsContributor: true, municipalityCode: '3550308' },
};

const document: BrFiscalDocument = {
  number: 'INV-0001',
  issueDate: '2026-10-15',
  dueDate: '2026-10-15',
  notes: null,
  fiscal: {},
  isCreditNote: false,
};

function build(
  regime: BrTaxRegime,
  profiles: Array<{ profile: string; line?: Partial<BrFiscalLine> }>,
  options: {
    settings?: BrFiscalSettings;
    counterparty?: BrFiscalCounterparty;
    document?: Partial<BrFiscalDocument>;
    withholdings?: NonNullable<BuildPayloadArgs['document']['fiscal']['withholdings']>;
    environment?: 'homologacao' | 'producao';
  } = {},
): BuildPayloadArgs {
  const lines = profiles.map((p) => line(p.profile, p.line));
  const doc = { ...document, ...options.document, fiscal: { ...document.fiscal, ...options.document?.fiscal, ...(options.withholdings ? { withholdings: options.withholdings } : {}) } };
  const settings: BrFiscalSettings = { uf: 'SP', municipalityCode: '3550308', inscricaoMunicipal: '12345', issRate: 5, ...options.settings };
  const counterparty = options.counterparty ?? customer;
  const inputs: DocumentTaxLineInput[] = lines.map((l, i) => ({
    lineTotal: l.lineTotal,
    taxRateId: `rate_${i}`,
    taxRateName: profiles[i].profile,
    taxCategoryCode: 'standard',
    rate: 0,
    jurisdictionMetadata: profileMetadata(profiles[i].profile),
    fiscalData: l.fiscal as Record<string, unknown>,
  }));
  const result = computeBrDocumentTaxes(inputs, {
    direction: 'sales',
    issueDate: doc.issueDate,
    entitySettings: settings as Record<string, unknown>,
    entityTaxClassification: regime,
    counterparty: { country: counterparty.address.country, stateCode: counterparty.address.state, taxId: counterparty.taxId, fiscal: counterparty.fiscal as Record<string, unknown> },
    documentFiscal: doc.fiscal as Record<string, unknown>,
  });
  return {
    environment: options.environment ?? 'producao',
    now: NOW,
    issuer: { cnpj: '12345678000123', regime, inscricaoEstadual: '123456789', settings },
    counterparty,
    document: doc,
    lines,
    taxes: { lines: result.lines.map((l) => l.rows), withheld: result.documentRows },
  };
}

describe('helpers', () => {
  it('splits a street line into street and number', () => {
    expect(splitStreet('Rua das Flores, 123')).toEqual({ street: 'Rua das Flores', number: '123' });
    expect(splitStreet('Rua 25 de Março, 100')).toEqual({ street: 'Rua 25 de Março', number: '100' });
    expect(splitStreet('Avenida Brasil 1500')).toEqual({ street: 'Avenida Brasil', number: '1500' });
    expect(splitStreet('Rua Sem Numero')).toEqual({ street: 'Rua Sem Numero', number: 'S/N' });
  });

  it('turns an LC 116 item into the national and municipal codes', () => {
    expect(nationalServiceCode('01.07')).toBe('010701');
    expect(nationalServiceCode('1.07')).toBe('010701');
    expect(nationalServiceCode('010702')).toBe('010702');
    expect(nationalServiceCode('abc')).toBeNull();
    expect(municipalServiceItem('01.07')).toBe('0107');
  });

  it('maps a sale CFOP to the CFOP of its devolução', () => {
    expect(returnCfop('5102')).toBe('1202');
    expect(returnCfop('6101')).toBe('2201');
    expect(returnCfop('1202')).toBe('1202');
  });
});

describe('chooseFiscalKind', () => {
  it('sends goods to the NF-e and services to the national NFS-e', () => {
    expect(chooseFiscalKind([line('venda_mercadoria')], {})).toBe('nfe');
    expect(chooseFiscalKind([line('servico_iss_5', { ncm: null })], {})).toBe('nfsen');
  });

  it('uses the municipal NFS-e when the entity chose it', () => {
    expect(chooseFiscalKind([line('servico_iss_5', { ncm: null })], { nfseStandard: 'municipal' })).toBe('nfse');
  });

  it('refuses an invoice with goods and services', () => {
    expect(() => chooseFiscalKind([line('venda_mercadoria'), line('servico_iss_5', { ncm: null })], {})).toThrow(/Split it/);
  });

  it('lets an exempt line follow the others, and refuses when nothing says', () => {
    expect(chooseFiscalKind([line('venda_mercadoria'), line('isento')], {})).toBe('nfe');
    expect(() => chooseFiscalKind([line('isento', { ncm: null })], {})).toThrow(BrPayloadError);
  });
});

describe('buildNfePayload', () => {
  it('builds a Simples Nacional sale (CSOSN 102, PIS/COFINS 07, Pix payment)', () => {
    const payload = buildNfePayload(
      build('simples_nacional', [{ profile: 'sn_comercio_i' }], { settings: { pixKey: 'pix@empresa.com.br' }, document: { dueDate: '2026-11-15' } }),
    );
    expect(payload).toMatchObject({
      natureza_operacao: 'Venda de mercadoria',
      data_emissao: '2026-10-15T10:00:00-03:00',
      tipo_documento: 1,
      local_destino: 1,
      finalidade_emissao: 1,
      consumidor_final: 0,
      cnpj_emitente: '12345678000123',
      inscricao_estadual_emitente: '123456789',
      regime_tributario_emitente: 1,
      cnpj_destinatario: '99887766000155',
      indicador_inscricao_estadual_destinatario: 1,
      inscricao_estadual_destinatario: '140212370',
      logradouro_destinatario: 'Rua das Flores',
      numero_destinatario: '123',
      bairro_destinatario: 'Centro',
      codigo_municipio_destinatario: '3550308',
      uf_destinatario: 'SP',
      cep_destinatario: '01311000',
      modalidade_frete: 9,
      formas_pagamento: [{ indicador_pagamento: 1, forma_pagamento: '17', valor_pagamento: 200 }],
    });
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      numero_item: 1,
      codigo_ncm: '49111090',
      cfop: '5102',
      unidade_comercial: 'UN',
      quantidade_comercial: 2,
      valor_unitario_comercial: 100,
      valor_bruto: 200,
      icms_origem: 0,
      icms_situacao_tributaria: '102',
      pis_situacao_tributaria: '07',
      cofins_situacao_tributaria: '07',
    });
    // A Simples Nacional issuer charges no itemised tax: no IBS/CBS group, no ICMS values.
    expect(items[0]).not.toHaveProperty('icms_valor');
    expect(items[0]).not.toHaveProperty('ibs_cbs_situacao_tributaria');
    expect(String(payload.informacoes_adicionais_contribuinte)).toContain('OPTANTE PELO SIMPLES NACIONAL');
  });

  it('uses the homologação recipient name in the sandbox', () => {
    const payload = buildNfePayload(build('simples_nacional', [{ profile: 'sn_comercio_i' }], { environment: 'homologacao' }));
    expect(payload.nome_destinatario).toBe(HOMOLOGACAO_RECIPIENT_NAME);
    expect(buildNfePayload(build('simples_nacional', [{ profile: 'sn_comercio_i' }])).nome_destinatario).toBe('Cliente Comercial Ltda');
  });

  it('sends CSOSN 101 with the credit when the entity has a credit rate', () => {
    const payload = buildNfePayload(build('simples_nacional', [{ profile: 'sn_comercio_i' }], { settings: { simplesCreditRate: 1.25 } }));
    const [item] = payload.items as Array<Record<string, unknown>>;
    expect(item).toMatchObject({ icms_situacao_tributaria: '101', icms_aliquota_credito_simples: 1.25, icms_valor_credito_simples: 2.5 });
    expect(String(payload.informacoes_adicionais_contribuinte)).toContain('ART. 23 DA LC 123/2006');
  });

  it('builds a Lucro Presumido sale with ICMS 00, PIS/COFINS 01 and the 2026 IBS/CBS test rates', () => {
    const payload = buildNfePayload(build('lucro_presumido', [{ profile: 'venda_mercadoria' }]));
    const [item] = payload.items as Array<Record<string, unknown>>;
    // 18% ICMS inside the price; PIS 0.65% and COFINS 3% on the price less the ICMS (STF Tema 69).
    expect(item).toMatchObject({
      icms_situacao_tributaria: '00',
      icms_modalidade_base_calculo: 3,
      icms_base_calculo: 200,
      icms_aliquota: 18,
      icms_valor: 36,
      pis_situacao_tributaria: '01',
      pis_base_calculo: 164,
      pis_aliquota_porcentual: 0.65,
      pis_valor: 1.07,
      cofins_situacao_tributaria: '01',
      cofins_aliquota_porcentual: 3,
      cofins_valor: 4.92,
      ibs_cbs_situacao_tributaria: '000',
      ibs_cbs_classificacao_tributaria: '000001',
      cbs_aliquota: 0.9,
      ibs_uf_aliquota: 0.1,
    });
    expect(payload.regime_tributario_emitente).toBe(3);
    expect(payload.formas_pagamento).toEqual([{ indicador_pagamento: 0, forma_pagamento: '99', descricao_pagamento: 'Outros', valor_pagamento: 200 }]);
  });

  it('adds IPI with the legal framing code for own production', () => {
    const payload = buildNfePayload(build('lucro_real', [{ profile: 'venda_producao', line: { fiscal: { ipiRate: 5 } } }]));
    const [item] = payload.items as Array<Record<string, unknown>>;
    expect(item).toMatchObject({ ipi_situacao_tributaria: '50', ipi_codigo_enquadramento_legal: '999', ipi_base_calculo: 200, ipi_aliquota: 5, ipi_valor: 10 });
    // The payment covers the price plus the IPI on top.
    expect(payload.formas_pagamento).toEqual([expect.objectContaining({ valor_pagamento: 210 })]);
    expect(item.cfop).toBe('5101');
  });

  it('marks an interstate sale and uses the interstate CFOP', () => {
    const payload = buildNfePayload(build('lucro_presumido', [{ profile: 'venda_mercadoria' }], { counterparty: { ...customer, address: { ...customer.address, state: 'RJ' } } }));
    expect(payload.local_destino).toBe(2);
    const [item] = payload.items as Array<Record<string, unknown>>;
    expect(item.cfop).toBe('6102');
    // 12% between SP and RJ.
    expect(item.icms_aliquota).toBe(12);
  });

  it('keeps a line CFOP and splits the discount per line', () => {
    const payload = buildNfePayload(
      build('simples_nacional', [{ profile: 'sn_comercio_i', line: { cfop: '5405', discountPercent: 10, lineTotal: 180 } }]),
    );
    const [item] = payload.items as Array<Record<string, unknown>>;
    expect(item).toMatchObject({ cfop: '5405', valor_bruto: 200, valor_desconto: 20 });
  });

  it('marks an individual as a non taxpayer and final consumer', () => {
    const payload = buildNfePayload(
      build('simples_nacional', [{ profile: 'sn_comercio_i' }], {
        counterparty: { ...customer, taxId: '529.982.247-25', fiscal: { municipalityCode: '3550308' } },
      }),
    );
    expect(payload).toMatchObject({ cpf_destinatario: '52998224725', indicador_inscricao_estadual_destinatario: 9, consumidor_final: 1 });
    expect(payload).not.toHaveProperty('cnpj_destinatario');
  });

  it('builds the entrada of a devolução for a credit note, referencing the NF-e', () => {
    const key = '41261012345678000123550010000000221923094166';
    const payload = buildNfePayload(
      build('simples_nacional', [{ profile: 'sn_comercio_i', line: { cfop: '5102' } }], { document: { isCreditNote: true, referencedAccessKey: key } }),
    );
    expect(payload).toMatchObject({
      tipo_documento: 0,
      finalidade_emissao: 4,
      natureza_operacao: 'Devolucao de venda de mercadoria',
      notas_referenciadas: [{ chave_nfe: key }],
      formas_pagamento: [{ indicador_pagamento: 0, forma_pagamento: '90', valor_pagamento: 0 }],
    });
    const [item] = payload.items as Array<Record<string, unknown>>;
    expect(item).toMatchObject({ cfop: '1202', icms_situacao_tributaria: '400' });
  });

  it('lists everything that is missing at once', () => {
    const args = build('simples_nacional', [{ profile: 'sn_comercio_i', line: { ncm: null } }], {
      counterparty: { ...customer, address: { ...customer.address, county: undefined }, fiscal: { icmsContributor: true } },
    });
    args.issuer.inscricaoEstadual = null;
    try {
      buildNfePayload(args);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrPayloadError);
      const missing = (err as BrPayloadError).missing;
      expect(missing).toEqual(
        expect.arrayContaining([
          "the entity's Inscrição Estadual (registration number)",
          "the customer's Inscrição Estadual (or mark it as not an ICMS taxpayer)",
          "the customer's neighbourhood (bairro)",
          "the customer's IBGE municipality code",
          'line 1: NCM (8 digits)',
        ]),
      );
    }
  });
});

describe('buildNfsenPayload', () => {
  const service = { profile: 'servico_iss_5', line: { ncm: null, cfop: null, description: 'Desenvolvimento de software', quantity: 1, unitPrice: 1500, lineTotal: 1500, fiscal: { serviceCode: '01.07' } } };

  it('builds a Simples Nacional service: option 3, no ISS rate, nothing withheld', () => {
    const payload = buildNfsenPayload({ ...build('simples_nacional', [{ ...service, profile: 'sn_servicos_iii' }]), dpsNumber: 45 });
    expect(payload).toMatchObject({
      data_emissao: '2026-10-15T10:00:00-03:00',
      data_competencia: '2026-10-15',
      serie_dps: 1,
      numero_dps: 45,
      emitente_dps: 1,
      codigo_municipio_emissora: 3550308,
      cnpj_prestador: '12345678000123',
      inscricao_municipal_prestador: '12345',
      codigo_opcao_simples_nacional: 3,
      regime_tributario_simples_nacional: 1,
      cnpj_tomador: '99887766000155',
      razao_social_tomador: 'Cliente Comercial Ltda',
      codigo_municipio_tomador: 3550308,
      codigo_tributacao_nacional_iss: '010701',
      descricao_servico: 'Desenvolvimento de software',
      valor_servico: 1500,
      tributacao_iss: 1,
      tipo_retencao_iss: 1,
    });
    expect(payload).not.toHaveProperty('percentual_aliquota_relativa_municipio');
    expect(payload).not.toHaveProperty('valor_irrf');
  });

  it('reports the ISS rate and the retentions of a Lucro Presumido service', () => {
    const payload = buildNfsenPayload({
      ...build('lucro_presumido', [service], { withholdings: { iss: 2, irrf: 1.5, csrf: true, inss: 11 } }),
      dpsNumber: 7,
    });
    expect(payload).toMatchObject({
      codigo_opcao_simples_nacional: 1,
      percentual_aliquota_relativa_municipio: 5,
      tipo_retencao_iss: 2,
      valor_irrf: 22.5,
      valor_cp: 165,
      situacao_tributaria_pis_cofins: '01',
      valor_pis: 9.75,
      valor_cofins: 45,
      valor_csll: 15,
      tipo_retencao_pis_cofins: 3,
      ibs_cbs_situacao_tributaria: '000',
      ibs_cbs_classificacao_tributaria: '000001',
    });
  });

  it('caps the competência at the emission date', () => {
    const payload = buildNfsenPayload({ ...build('lucro_presumido', [service], { document: { issueDate: '2026-12-01' } }), dpsNumber: 1 });
    expect(payload.data_competencia).toBe('2026-10-15');
  });

  it('asks for the service code, the municipality and the inscrição municipal', () => {
    const args = build('lucro_presumido', [{ ...service, line: { ...service.line, fiscal: {} } }], { settings: { municipalityCode: undefined, inscricaoMunicipal: undefined } });
    expect(() => buildNfsenPayload({ ...args, dpsNumber: 1 })).toThrow(/municipality code.*Inscrição Municipal.*LC 116 service code/);
  });

  it('refuses several service codes and a customer abroad', () => {
    const two = build('lucro_presumido', [service, { ...service, line: { ...service.line, fiscal: { serviceCode: '17.01' } } }]);
    expect(() => buildNfsenPayload({ ...two, dpsNumber: 1 })).toThrow(/several/);
    const abroad = build('lucro_presumido', [service], { counterparty: { ...customer, address: { ...customer.address, country: 'US' } } });
    expect(() => buildNfsenPayload({ ...abroad, dpsNumber: 1 })).toThrow(/abroad/);
  });
});

describe('buildNfsePayload (municipal)', () => {
  it('builds nested prestador, tomador and servico objects', () => {
    const payload = buildNfsePayload(
      build('lucro_presumido', [{ profile: 'servico_iss_3', line: { ncm: null, description: 'Consultoria', quantity: 1, unitPrice: 1000, lineTotal: 1000, fiscal: { serviceCode: '17.01' } } }], {
        settings: { codigoTributarioMunicipio: '620910000', cnae: '6209100' },
        withholdings: { iss: 3 },
      }),
    );
    expect(payload).toMatchObject({
      data_emissao: '2026-10-15T10:00:00-03:00',
      natureza_operacao: '1',
      optante_simples_nacional: false,
      prestador: { cnpj: '12345678000123', inscricao_municipal: '12345', codigo_municipio: '3550308' },
      tomador: {
        cnpj: '99887766000155',
        razao_social: 'Cliente Comercial Ltda',
        endereco: { logradouro: 'Rua das Flores', numero: '123', bairro: 'Centro', codigo_municipio: '3550308', uf: 'SP', cep: '01311000' },
      },
      servico: {
        valor_servicos: 1000,
        iss_retido: true,
        valor_iss: 30,
        valor_iss_retido: 30,
        aliquota: 3,
        item_lista_servico: '1701',
        codigo_cnae: '6209100',
        codigo_tributario_municipio: '620910000',
        codigo_municipio: '3550308',
      },
    });
  });
});
