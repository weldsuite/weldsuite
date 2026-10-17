import type { TaxCategoryTemplate } from '../types';
import type { BrTaxRegime } from './regimes';
import { isSimplesRegime } from './regimes';

export type BrSimplesAnexo = 'I' | 'II' | 'III' | 'IV' | 'V';

/**
 * What a line sells or buys, which decides the taxes on it:
 * - service: ISS (municipal) + PIS/COFINS
 * - goods_resale: ICMS + PIS/COFINS
 * - goods_production: ICMS + IPI + PIS/COFINS (an industrial establishment)
 * - export_service / export_goods: immune or exempt from all of them
 * - exempt: no tax (isento / não tributado)
 */
export type BrSupplyKind = 'service' | 'goods_resale' | 'goods_production' | 'export_service' | 'export_goods' | 'exempt';

/**
 * A Brazilian tax rate is a tax *profile*: one line carries several taxes with
 * their own bases, so the seeded rate holds the recipe in its
 * jurisdiction_metadata (`{ br: BrTaxProfile }`) and the engine
 * (tax-engine.ts) works the amounts out. The rate's own `rate` column is 0.
 */
export interface BrTaxProfile {
  profile: string;
  regimes: BrTaxRegime[];
  kind: BrSupplyKind;
  /** Simples Nacional annex the revenue counts toward. */
  simplesAnexo?: BrSimplesAnexo;
  /** ISS rate when the line has no override, percent (else the entity's issRate, else 5). */
  issRate?: number;
  /** Purchases: which taxes inside the price are credited (a recuperar). */
  credits?: { icms?: boolean; ipi?: boolean; pisCofins?: boolean };
}

export function brProfileOf(metadata: Record<string, unknown> | null | undefined): BrTaxProfile | undefined {
  const br = metadata?.br as BrTaxProfile | undefined;
  return br && typeof br.profile === 'string' && typeof br.kind === 'string' ? br : undefined;
}

function profile(
  name: string,
  type: TaxCategoryTemplate['type'],
  br: BrTaxProfile,
  extra: Partial<TaxCategoryTemplate> = {},
): TaxCategoryTemplate {
  const exempt = br.kind === 'exempt';
  const exportKind = br.kind === 'export_goods' || br.kind === 'export_service';
  let taxCategoryCode: TaxCategoryTemplate['taxCategoryCode'] = 'standard';
  if (exempt) taxCategoryCode = 'exempt';
  else if (exportKind) taxCategoryCode = 'export_goods';
  return {
    name,
    rate: '0.00',
    type,
    taxCategoryCode,
    jurisdictionMetadata: { br } as unknown as Record<string, unknown>,
    ...extra,
  };
}

const SIMPLES: BrTaxRegime[] = ['simples_nacional'];
const MEI: BrTaxRegime[] = ['mei'];
const PRESUMIDO: BrTaxRegime[] = ['lucro_presumido'];
const REAL: BrTaxRegime[] = ['lucro_real'];
const NORMAL: BrTaxRegime[] = ['lucro_presumido', 'lucro_real'];
const ALL: BrTaxRegime[] = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'];

/**
 * Every profile WeldBooks seeds for a BR entity. Names are Portuguese (pt-BR
 * is the entity's default locale). The ones that don't fit the entity's
 * regime are seeded switched off, so a change of regime (allowed each
 * January) is a matter of switching profiles on, not of creating them.
 */
export const BR_TAX_PROFILES: TaxCategoryTemplate[] = [
  // Simples Nacional: no tax itemised; the annex drives the DAS.
  profile('Simples Nacional — Serviços (Anexo III)', 'sales', { profile: 'sn_servicos_iii', regimes: SIMPLES, kind: 'service', simplesAnexo: 'III' }),
  profile('Simples Nacional — Serviços (Anexo IV)', 'sales', { profile: 'sn_servicos_iv', regimes: SIMPLES, kind: 'service', simplesAnexo: 'IV' }),
  profile('Simples Nacional — Serviços (Anexo V)', 'sales', { profile: 'sn_servicos_v', regimes: SIMPLES, kind: 'service', simplesAnexo: 'V' }),
  profile('Simples Nacional — Comércio (Anexo I)', 'sales', { profile: 'sn_comercio_i', regimes: SIMPLES, kind: 'goods_resale', simplesAnexo: 'I' }),
  profile('Simples Nacional — Indústria (Anexo II)', 'sales', { profile: 'sn_industria_ii', regimes: SIMPLES, kind: 'goods_production', simplesAnexo: 'II' }),
  profile('Simples Nacional — Exportação de serviços', 'sales', { profile: 'sn_exportacao_servicos', regimes: SIMPLES, kind: 'export_service', simplesAnexo: 'III' }),

  // MEI: a fixed DAS-MEI, nothing per invoice.
  profile('MEI — Serviços', 'sales', { profile: 'mei_servicos', regimes: MEI, kind: 'service' }),
  profile('MEI — Comércio e indústria', 'sales', { profile: 'mei_comercio', regimes: MEI, kind: 'goods_resale' }),

  // Lucro Presumido / Real: taxes itemised per line.
  profile('Serviço — ISS 5% + PIS/COFINS', 'sales', { profile: 'servico_iss_5', regimes: NORMAL, kind: 'service', issRate: 5 }),
  profile('Serviço — ISS 3% + PIS/COFINS', 'sales', { profile: 'servico_iss_3', regimes: NORMAL, kind: 'service', issRate: 3 }),
  profile('Serviço — ISS 2% + PIS/COFINS', 'sales', { profile: 'servico_iss_2', regimes: NORMAL, kind: 'service', issRate: 2 }),
  profile('Venda de mercadoria — ICMS + PIS/COFINS', 'sales', { profile: 'venda_mercadoria', regimes: NORMAL, kind: 'goods_resale' }),
  profile('Venda de produção própria — ICMS + IPI + PIS/COFINS', 'sales', { profile: 'venda_producao', regimes: NORMAL, kind: 'goods_production' }),
  profile('Exportação de serviços', 'sales', { profile: 'exportacao_servicos', regimes: NORMAL, kind: 'export_service' }),
  profile('Exportação de mercadorias', 'sales', { profile: 'exportacao_mercadorias', regimes: NORMAL, kind: 'export_goods' }),

  // Purchases
  profile('Compra de mercadoria para revenda — com créditos', 'purchase', {
    profile: 'compra_revenda_credito',
    regimes: NORMAL,
    kind: 'goods_resale',
    credits: { icms: true, pisCofins: true },
  }),
  profile('Compra de insumos industriais — com créditos', 'purchase', {
    profile: 'compra_insumos_credito',
    regimes: NORMAL,
    kind: 'goods_production',
    credits: { icms: true, ipi: true, pisCofins: true },
  }),
  profile('Serviço tomado — com crédito de PIS/COFINS', 'purchase', {
    profile: 'servico_tomado_credito',
    regimes: REAL,
    kind: 'service',
    credits: { pisCofins: true },
  }),
  profile('Compra ou despesa sem crédito', 'purchase', { profile: 'compra_sem_credito', regimes: ALL, kind: 'exempt' }),

  // Either way
  profile('Isento / não tributado', 'both', { profile: 'isento', regimes: ALL, kind: 'exempt' }),
];

/** The profile that should be the default sale rate for a regime. */
const DEFAULT_SALE_PROFILE: Record<BrTaxRegime, string> = {
  mei: 'mei_servicos',
  simples_nacional: 'sn_servicos_iii',
  lucro_presumido: 'servico_iss_5',
  lucro_real: 'servico_iss_5',
};

/** The seeded rates for a regime: its own profiles active (one default), the rest switched off. */
export function brTaxCategoriesFor(regime: BrTaxRegime): TaxCategoryTemplate[] {
  return BR_TAX_PROFILES.map((t) => {
    const br = brProfileOf(t.jurisdictionMetadata)!;
    const active = br.regimes.includes(regime);
    return { ...t, isActive: active, isDefault: br.profile === DEFAULT_SALE_PROFILE[regime] };
  });
}

/** True when a profile's taxes are paid inside the DAS for this regime. */
export function profileUsesDas(regime: BrTaxRegime): boolean {
  return isSimplesRegime(regime);
}
