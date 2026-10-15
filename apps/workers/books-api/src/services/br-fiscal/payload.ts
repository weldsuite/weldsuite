/**
 * Focus NFe request payloads for a Brazilian invoice: NF-e (goods, `/v2/nfe`),
 * NFS-e Nacional (services, `/v2/nfsen`) and municipal NFS-e (`/v2/nfse`).
 *
 * Pure functions: they take what the invoice, its lines, the entity and the
 * customer hold, plus the taxes the BR engine works out per line, and return the
 * JSON body. Field names follow docs/plans/weldbooks-br/focusnfe-api.md.
 *
 * Money in an invoice is the price with ISS, ICMS, PIS and COFINS inside it
 * ("por dentro") and IPI on top, so each tax comes from the engine's breakdown
 * rows of the line rather than from a rate on the invoice.
 */

import {
  crtOf,
  isSimplesRegime,
  type BrDocumentFiscalData,
  type BrEntitySettings,
  type BrLineFiscalData,
  type BrSupplyKind,
  type BrTaxRegime,
} from '@weldsuite/books-domain/jurisdictions/br';
import type { DocumentTaxRow } from '@weldsuite/books-domain/jurisdictions/types';
import type { FocusDocumentKind, FocusEnvironment, FocusRecord } from './focus-client';

/** SEFAZ requires this name on the destinatário of a homologação NF-e. */
export const HOMOLOGACAO_RECIPIENT_NAME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/** A payload cannot be built because data the document needs is missing or unsupported; each entry says what to fill in. */
export class BrPayloadError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(missing.length > 0 ? `${message}: ${missing.join('; ')}` : message);
    this.name = 'BrPayloadError';
  }
}

/** entities.jurisdiction_settings fields the fiscal documents read, on top of the BR settings. */
export interface BrFiscalSettings extends BrEntitySettings {
  /** Services: the national NFS-e (default) or the municipality's own system. */
  nfseStandard?: 'nacional' | 'municipal';
  /** NFS-e Nacional DPS series (1 to 49999, default 1). */
  dpsSeries?: number;
  /** Simples Nacional credit rate printed on NF-e (CSOSN 101), percent. */
  simplesCreditRate?: number;
  /** The municipality's own service code (municipal NFS-e). */
  codigoTributarioMunicipio?: string;
}

/** The address shape of a document or party (shared PostalAddress). */
export interface BrFiscalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  /** Holds the neighbourhood (bairro). */
  county?: string;
}

export interface BrFiscalIssuer {
  /** The entity's CNPJ (vat number). */
  cnpj: string;
  regime: BrTaxRegime;
  /** Inscrição estadual (entity registration number). */
  inscricaoEstadual?: string | null;
  settings: BrFiscalSettings;
}

export interface BrFiscalCounterparty {
  name: string;
  email?: string | null;
  /** CNPJ or CPF. */
  taxId?: string | null;
  address: BrFiscalAddress;
  fiscal: {
    inscricaoEstadual?: string;
    inscricaoMunicipal?: string;
    icmsContributor?: boolean;
    simplesNacional?: boolean;
    municipalityCode?: string;
  };
}

/** The line's fiscal fields as the NF-e needs them: the engine's, plus the ones the line form stores for the 2026 reform. */
export type BrFiscalLineData = BrLineFiscalData & {
  nbs?: string;
  ibsCbsCst?: string;
  cClassTrib?: string;
};

export interface BrFiscalLine {
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  unit?: string | null;
  /** Net amount: quantity x price less the line discount. */
  lineTotal: number;
  productCode?: string | null;
  ncm?: string | null;
  cfop?: string | null;
  fiscal: BrFiscalLineData;
  /** The kind of the line's tax profile (service, goods_resale...). */
  kind?: BrSupplyKind;
}

export interface BrFiscalDocument {
  number?: string | null;
  /** yyyy-mm-dd */
  issueDate: string;
  /** yyyy-mm-dd */
  dueDate?: string | null;
  notes?: string | null;
  fiscal: BrDocumentFiscalData;
  /** A credit note: the NF-e is an entrada of devolução. */
  isCreditNote: boolean;
  /** Access key of the authorized NF-e a credit note returns. */
  referencedAccessKey?: string | null;
  /** Sold through the online shop (presença do comprador: internet). */
  online?: boolean;
}

/** What the BR tax engine worked out: breakdown rows per line, and the withheld rows of the document. */
export interface BrFiscalTaxes {
  lines: DocumentTaxRow[][];
  withheld: DocumentTaxRow[];
}

export interface BuildPayloadArgs {
  environment: FocusEnvironment;
  now: Date;
  issuer: BrFiscalIssuer;
  counterparty: BrFiscalCounterparty;
  document: BrFiscalDocument;
  lines: BrFiscalLine[];
  taxes: BrFiscalTaxes;
}

export interface NfsePayloadArgs extends BuildPayloadArgs {
  /** NFS-e Nacional: the DPS number, from the entity's sequence. */
  dpsNumber?: number;
}

// --- Small helpers ------------------------------------------------------------

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function compact(record: FocusRecord): FocusRecord {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** `now` as ISO 8601 in Brasília time (UTC-3, no daylight saving since 2019). */
export function brasiliaIso(now: Date): string {
  return `${new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19)}-03:00`;
}

export function brasiliaDate(now: Date): string {
  return brasiliaIso(now).slice(0, 10);
}

function isForeign(country: string | null | undefined): boolean {
  const c = (country ?? '').trim().toUpperCase();
  return c !== '' && c !== 'BR' && c !== 'BRA' && c !== 'BRAZIL' && c !== 'BRASIL';
}

function sumRows(rows: DocumentTaxRow[], component: string): number {
  return round2(rows.filter((r) => r.component === component).reduce((s, r) => s + r.taxAmount, 0));
}

function rowOf(rows: DocumentTaxRow[], component: string): DocumentTaxRow | undefined {
  return rows.find((r) => r.component === component);
}

/** "Rua das Flores, 123" or "Rua das Flores 123" -> street and number ("S/N" when there is none). */
export function splitStreet(line1: string | undefined): { street: string; number: string } {
  const text = (line1 ?? '').trim();
  const comma = /^(.+?),\s*(\d+[A-Za-z]?|s\/?n)\b/i.exec(text);
  if (comma) return { street: comma[1].trim(), number: comma[2].toUpperCase() };
  const trailing = /^(.+?)\s+(\d+[A-Za-z]?|s\/?n)$/i.exec(text);
  if (trailing) return { street: trailing[1].trim(), number: trailing[2].toUpperCase() };
  return { street: text, number: 'S/N' };
}

/** CFOP of the entrada that returns goods sold under `cfop` (5102 -> 1202, 6102 -> 2202). */
export function returnCfop(cfop: string): string {
  if (/^[123]/.test(cfop)) return cfop;
  const known: Record<string, string> = { '5101': '1201', '5102': '1202', '6101': '2201', '6102': '2202', '7101': '3201', '7102': '3202' };
  if (known[cfop]) return known[cfop];
  const first = cfop[0] === '5' ? '1' : cfop[0] === '6' ? '2' : cfop[0] === '7' ? '3' : cfop[0];
  return `${first}${cfop.slice(1)}`;
}

/** The CFOP of a sale line when the line has none: own production (5101) or resale (5102), by destination. */
export function defaultSaleCfop(kind: BrSupplyKind | undefined, destination: 1 | 2 | 3): string {
  const base = kind === 'goods_production' ? '101' : '102';
  return `${destination === 1 ? '5' : destination === 2 ? '6' : '7'}${base}`;
}

/** LC 116 item ("01.07", "0107", "1.07") as the 6-digit national code (cTribNac): item, subitem, desdobro. */
export function nationalServiceCode(code: string): string | null {
  const digits = digitsOf(code);
  if (digits.length === 6) return digits;
  if (digits.length >= 3 && digits.length <= 4) return `${digits.padStart(4, '0')}01`;
  return null;
}

/** LC 116 item as the 4 digits municipal systems take ("0107"). */
export function municipalServiceItem(code: string): string | null {
  const national = nationalServiceCode(code);
  return national ? national.slice(0, 4) : null;
}

// --- Which document an invoice needs --------------------------------------------

export type BrFiscalDocumentCategory = 'goods' | 'service';

/** goods or service by the line's tax profile, falling back to what its fiscal fields hint at; null when nothing says. */
export function lineCategory(line: Pick<BrFiscalLine, 'kind' | 'ncm' | 'cfop' | 'fiscal'>): BrFiscalDocumentCategory | null {
  if (line.kind === 'service' || line.kind === 'export_service') return 'service';
  if (line.kind === 'goods_resale' || line.kind === 'goods_production' || line.kind === 'export_goods') return 'goods';
  if (line.ncm || line.cfop) return 'goods';
  if (line.fiscal.serviceCode) return 'service';
  return null;
}

/**
 * The Focus document kind for an invoice: services go to the national NFS-e
 * unless the entity chose its municipality's own system, goods to the NF-e.
 * One document covers one kind, so a mixed invoice is refused.
 */
export function chooseFiscalKind(lines: Array<Pick<BrFiscalLine, 'kind' | 'ncm' | 'cfop' | 'fiscal'>>, settings: BrFiscalSettings): FocusDocumentKind {
  const categories = new Set(lines.map(lineCategory).filter((c): c is BrFiscalDocumentCategory => c !== null));
  if (categories.size > 1) {
    throw new BrPayloadError('This invoice mixes goods and services, which need different fiscal documents (NF-e and NFS-e). Split it into two invoices');
  }
  const [category] = [...categories];
  if (!category) {
    throw new BrPayloadError('The lines have no tax profile that says whether they are goods or services. Give them a tax rate (or an NCM or LC 116 code)');
  }
  if (category === 'goods') return 'nfe';
  return settings.nfseStandard === 'municipal' ? 'nfse' : 'nfsen';
}

// --- Recipient ------------------------------------------------------------------

/** Whether the buyer counts as an ICMS taxpayer: what the document says, else its party, else a CNPJ. */
export function buyerIsIcmsContributor(args: Pick<BuildPayloadArgs, 'counterparty' | 'document'>): boolean {
  const { counterparty, document } = args;
  return document.fiscal.buyerIcmsContributor ?? counterparty.fiscal.icmsContributor ?? digitsOf(counterparty.taxId).length === 14;
}

function counterpartyId(counterparty: BrFiscalCounterparty): { kind: 'cnpj' | 'cpf'; value: string } | null {
  const id = digitsOf(counterparty.taxId);
  if (id.length === 14) return { kind: 'cnpj', value: id };
  if (id.length === 11) return { kind: 'cpf', value: id };
  // Alphanumeric CNPJ (July 2026): digits-only stripping would cut it, so test the raw form too.
  const raw = (counterparty.taxId ?? '').replace(/[\s./-]/g, '').toUpperCase();
  if (/^[0-9A-Z]{12}\d{2}$/.test(raw)) return { kind: 'cnpj', value: raw };
  return null;
}

function localDestination(issuer: BrFiscalIssuer, counterparty: BrFiscalCounterparty, missing: string[]): 1 | 2 | 3 {
  if (isForeign(counterparty.address.country)) return 3;
  const issuerUf = issuer.settings.uf?.toUpperCase();
  const uf = counterparty.address.state?.toUpperCase();
  if (!issuerUf) missing.push("the entity's state (UF) in its Brazil settings");
  if (!uf) missing.push("the customer's state (UF)");
  if (!issuerUf || !uf) return 1;
  return issuerUf === uf ? 1 : 2;
}

// --- NF-e (goods) -----------------------------------------------------------------

function ibsCbsFields(line: BrFiscalLine, rows: DocumentTaxRow[]): FocusRecord {
  const cbs = rowOf(rows, 'cbs');
  const ibs = rowOf(rows, 'ibs');
  if (!cbs && !ibs) return {};
  const base = cbs?.taxableAmount ?? ibs?.taxableAmount ?? 0;
  const cbsValue = cbs?.taxAmount ?? 0;
  const ibsValue = ibs?.taxAmount ?? 0;
  // The state/municipal split of the IBS is not set yet: the 2026 test rate is all state, the municipal share 0.
  return {
    ibs_cbs_situacao_tributaria: line.fiscal.ibsCbsCst ?? '000',
    ibs_cbs_classificacao_tributaria: line.fiscal.cClassTrib ?? '000001',
    ibs_cbs_base_calculo: round2(base),
    ibs_uf_aliquota: ibs?.taxRate ?? 0,
    ibs_uf_valor: round2(ibsValue),
    ibs_mun_aliquota: 0,
    ibs_mun_valor: 0,
    ibs_valor_total: round2(ibsValue),
    cbs_aliquota: cbs?.taxRate ?? 0,
    cbs_valor: round2(cbsValue),
  };
}

function nfeItem(
  index: number,
  line: BrFiscalLine,
  rows: DocumentTaxRow[],
  args: BuildPayloadArgs,
  destination: 1 | 2 | 3,
  missing: string[],
): FocusRecord {
  const { issuer, document } = args;
  const simples = isSimplesRegime(issuer.regime);
  const n = index + 1;

  const ncm = digitsOf(line.ncm);
  if (ncm.length !== 8) missing.push(`line ${n}: NCM (8 digits)`);

  let cfop = line.cfop || defaultSaleCfop(line.kind, destination);
  if (document.isCreditNote) cfop = returnCfop(cfop);

  const gross = round2(line.quantity * line.unitPrice);
  const discount = round2(gross - line.lineTotal);
  const item: FocusRecord = {
    numero_item: n,
    codigo_produto: line.productCode || String(n),
    descricao: line.description.trim().slice(0, 120),
    codigo_ncm: ncm,
    cest: line.fiscal.cest,
    codigo_barras_comercial: 'SEM GTIN',
    codigo_barras_tributavel: 'SEM GTIN',
    cfop,
    unidade_comercial: (line.unit || 'UN').toUpperCase().slice(0, 6),
    quantidade_comercial: line.quantity,
    valor_unitario_comercial: line.unitPrice,
    valor_bruto: gross,
    unidade_tributavel: (line.unit || 'UN').toUpperCase().slice(0, 6),
    quantidade_tributavel: line.quantity,
    valor_unitario_tributavel: line.unitPrice,
    valor_desconto: discount > 0 ? discount : undefined,
    inclui_no_total: 1,
    icms_origem: Number.parseInt(line.fiscal.origin ?? '0', 10) || 0,
  };

  const exempt = line.kind === 'exempt' || line.kind === 'export_goods';

  if (simples) {
    const credit = issuer.regime === 'simples_nacional' ? (issuer.settings.simplesCreditRate ?? 0) : 0;
    if (document.isCreditNote || exempt) {
      item.icms_situacao_tributaria = '400';
    } else if (credit > 0) {
      item.icms_situacao_tributaria = '101';
      item.icms_aliquota_credito_simples = credit;
      item.icms_valor_credito_simples = round2((line.lineTotal * credit) / 100);
    } else {
      item.icms_situacao_tributaria = '102';
    }
    // PIS and COFINS are inside the DAS: operação isenta da contribuição.
    item.pis_situacao_tributaria = '07';
    item.cofins_situacao_tributaria = '07';
  } else {
    const icms = rowOf(rows, 'icms');
    const fcp = rowOf(rows, 'fcp');
    if (icms) {
      item.icms_situacao_tributaria = '00';
      item.icms_modalidade_base_calculo = 3;
      item.icms_base_calculo = round2(icms.taxableAmount);
      item.icms_aliquota = icms.taxRate;
      item.icms_valor = round2(icms.taxAmount);
    } else {
      item.icms_situacao_tributaria = line.kind === 'exempt' ? '40' : '41';
    }
    if (fcp) {
      item.fcp_percentual = fcp.taxRate;
      item.fcp_base_calculo = round2(fcp.taxableAmount);
      item.fcp_valor = round2(fcp.taxAmount);
    }

    const ipi = rowOf(rows, 'ipi');
    if (ipi) {
      item.ipi_situacao_tributaria = '50';
      item.ipi_codigo_enquadramento_legal = '999';
      item.ipi_base_calculo = round2(ipi.taxableAmount);
      item.ipi_aliquota = ipi.taxRate;
      item.ipi_valor = round2(ipi.taxAmount);
    }

    for (const tax of ['pis', 'cofins'] as const) {
      const row = rowOf(rows, tax);
      if (row) {
        item[`${tax}_situacao_tributaria`] = '01';
        item[`${tax}_base_calculo`] = round2(row.taxableAmount);
        item[`${tax}_aliquota_porcentual`] = row.taxRate;
        item[`${tax}_valor`] = round2(row.taxAmount);
      } else {
        // 07 isenta (exempt lines), 08 sem incidência (exports, and from 2027 when CBS replaces them).
        item[`${tax}_situacao_tributaria`] = line.kind === 'exempt' ? '07' : '08';
      }
    }
    Object.assign(item, ibsCbsFields(line, rows));
  }
  return compact(item);
}

/** Text the Simples Nacional (and its credit) requires on every NF-e (LC 123/2006 art. 23, Res. CGSN 140). */
function simplesNotice(issuer: BrFiscalIssuer, credit: number, creditValue: number): string[] {
  if (!isSimplesRegime(issuer.regime)) return [];
  const notice = ['DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL', 'NAO GERA DIREITO A CREDITO FISCAL DE IPI'];
  if (credit > 0) {
    notice.splice(
      1,
      0,
      `PERMITE O APROVEITAMENTO DO CREDITO DE ICMS CORRESPONDENTE A ALIQUOTA DE ${credit.toFixed(2).replace('.', ',')}%, NO VALOR DE R$ ${creditValue.toFixed(2).replace('.', ',')}, NOS TERMOS DO ART. 23 DA LC 123/2006`,
    );
  }
  return notice;
}

/** NF-e (modelo 55) for goods: `POST /v2/nfe`. A credit note becomes the entrada of a devolução that references the original NF-e. */
export function buildNfePayload(args: BuildPayloadArgs): FocusRecord {
  const { environment, now, issuer, counterparty, document, lines, taxes } = args;
  const missing: string[] = [];
  const simples = isSimplesRegime(issuer.regime);

  if (!issuer.cnpj) missing.push("the entity's CNPJ");
  const ie = digitsOf(issuer.inscricaoEstadual);
  if (!ie) missing.push("the entity's Inscrição Estadual (registration number)");

  const destination = localDestination(issuer, counterparty, missing);
  const id = counterpartyId(counterparty);
  if (!id && destination !== 3) missing.push("the customer's CNPJ or CPF");

  const contributor = buyerIsIcmsContributor(args);
  const finalConsumer = document.fiscal.finalConsumer ?? !contributor;
  const buyerIe = digitsOf(counterparty.fiscal.inscricaoEstadual);
  const exemptIe = (counterparty.fiscal.inscricaoEstadual ?? '').toUpperCase() === 'ISENTO';
  let ieIndicator = 9;
  if (destination !== 3) {
    if (contributor && !exemptIe) {
      ieIndicator = 1;
      if (!buyerIe) missing.push("the customer's Inscrição Estadual (or mark it as not an ICMS taxpayer)");
    } else if (exemptIe) {
      ieIndicator = 2;
    }
  }

  const address = counterparty.address;
  const { street, number } = splitStreet(address.line1);
  if (destination !== 3) {
    if (!street) missing.push("the customer's street address");
    if (!address.county) missing.push("the customer's neighbourhood (bairro)");
    if (!address.city) missing.push("the customer's city");
    if (!counterparty.fiscal.municipalityCode) missing.push("the customer's IBGE municipality code");
  }

  const items = lines.map((line, i) => nfeItem(i, line, taxes.lines[i] ?? [], args, destination, missing));
  if (missing.length > 0) throw new BrPayloadError('The NF-e is missing data', [...new Set(missing)]);

  // What Focus adds up: price less discount, plus the taxes charged on top (IPI, later CBS/IBS).
  const total = round2(
    lines.reduce((sum, line, i) => sum + line.lineTotal + (taxes.lines[i] ?? []).filter((r) => r.treatment === 'added').reduce((s, r) => s + r.taxAmount, 0), 0),
  );
  const credit = simples && issuer.regime === 'simples_nacional' && !document.isCreditNote ? (issuer.settings.simplesCreditRate ?? 0) : 0;
  const creditValue = round2(lines.reduce((sum, l) => sum + (l.lineTotal * credit) / 100, 0));
  const extra = [
    ...simplesNotice(issuer, credit, creditValue),
    ...(document.number ? [`Fatura ${document.number}`] : []),
    ...(document.notes?.trim() ? [document.notes.trim()] : []),
  ];

  const issueIso = brasiliaIso(now);
  const onCredit = Boolean(document.dueDate && document.dueDate > document.issueDate);
  const payment = document.isCreditNote
    ? { indicador_pagamento: 0, forma_pagamento: '90', valor_pagamento: 0 }
    : {
        indicador_pagamento: onCredit ? 1 : 0,
        forma_pagamento: issuer.settings.pixKey ? '17' : '99',
        ...(issuer.settings.pixKey ? {} : { descricao_pagamento: 'Outros' }),
        valor_pagamento: total,
      };

  return compact({
    natureza_operacao: (document.fiscal.naturezaOperacao ?? (document.isCreditNote ? 'Devolucao de venda de mercadoria' : 'Venda de mercadoria')).slice(0, 60),
    data_emissao: issueIso,
    data_entrada_saida: issueIso,
    tipo_documento: document.isCreditNote ? 0 : 1,
    local_destino: destination,
    finalidade_emissao: document.isCreditNote ? 4 : 1,
    consumidor_final: finalConsumer ? 1 : 0,
    presenca_comprador: document.online ? 2 : 9,
    cnpj_emitente: issuer.cnpj,
    inscricao_estadual_emitente: ie,
    regime_tributario_emitente: Number.parseInt(crtOf(issuer.regime), 10),
    ...(issuer.settings.nfeSeries ? { serie: Number.parseInt(issuer.settings.nfeSeries, 10) || undefined } : {}),
    nome_destinatario: environment === 'homologacao' ? HOMOLOGACAO_RECIPIENT_NAME : counterparty.name.slice(0, 60),
    ...(id?.kind === 'cnpj' ? { cnpj_destinatario: id.value } : {}),
    ...(id?.kind === 'cpf' ? { cpf_destinatario: id.value } : {}),
    indicador_inscricao_estadual_destinatario: ieIndicator,
    inscricao_estadual_destinatario: ieIndicator === 1 ? buyerIe : undefined,
    ...(destination === 3
      ? { pais_destinatario: address.country, municipio_destinatario: address.city, logradouro_destinatario: street, numero_destinatario: number, bairro_destinatario: address.county }
      : {
          logradouro_destinatario: street,
          numero_destinatario: number,
          complemento_destinatario: address.line2,
          bairro_destinatario: address.county,
          municipio_destinatario: address.city,
          codigo_municipio_destinatario: counterparty.fiscal.municipalityCode,
          uf_destinatario: address.state?.toUpperCase(),
          cep_destinatario: digitsOf(address.postalCode) || undefined,
        }),
    email_destinatario: counterparty.email?.slice(0, 60),
    modalidade_frete: 9,
    notas_referenciadas: document.isCreditNote && document.referencedAccessKey ? [{ chave_nfe: document.referencedAccessKey }] : undefined,
    informacoes_adicionais_contribuinte: extra.length > 0 ? extra.join(' | ').slice(0, 5000) : undefined,
    formas_pagamento: [payment],
    items,
  });
}

// --- NFS-e (services) ---------------------------------------------------------------

/** Retentions of the invoice as the NFS-e reports them: ISS, IRRF, PIS, COFINS, CSLL, INSS. */
export function withholdingTotals(withheld: DocumentTaxRow[]) {
  return {
    iss: sumRows(withheld, 'iss_ret'),
    irrf: sumRows(withheld, 'irrf'),
    pis: sumRows(withheld, 'pis_ret'),
    cofins: sumRows(withheld, 'cofins_ret'),
    csll: sumRows(withheld, 'csll_ret'),
    inss: sumRows(withheld, 'inss_ret'),
  };
}

interface ServiceSummary {
  amount: number;
  description: string;
  serviceCode: string;
  nbs?: string;
  issRate?: number;
  issAmount: number;
  exportService: boolean;
  exempt: boolean;
}

function summarizeService(args: BuildPayloadArgs, missing: string[]): ServiceSummary {
  const { lines, taxes } = args;
  const codes = new Set(lines.map((l) => (l.fiscal.serviceCode ?? '').trim()).filter(Boolean));
  if (codes.size === 0) missing.push('the LC 116 service code on the lines (e.g. 01.07)');
  if (codes.size > 1) {
    throw new BrPayloadError('One NFS-e covers one service code, but the lines use several. Split the invoice per service code', [...codes]);
  }
  const [serviceCode = ''] = [...codes];

  const amount = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const description = lines
    .map((l) => (lines.length > 1 ? `${l.description.trim()} (${l.quantity} x ${l.unitPrice.toFixed(2)})` : l.description.trim()))
    .join('\n')
    .slice(0, 1000);
  const issRows = taxes.lines.flatMap((rows) => rows.filter((r) => r.component === 'iss'));
  return {
    amount,
    description,
    serviceCode,
    nbs: lines.map((l) => digitsOf(l.fiscal.nbs)).find(Boolean),
    issRate: issRows[0]?.taxRate,
    issAmount: round2(issRows.reduce((s, r) => s + r.taxAmount, 0)),
    exportService: lines.every((l) => l.kind === 'export_service'),
    exempt: lines.every((l) => l.kind === 'exempt'),
  };
}

function requireServiceIssuer(issuer: BrFiscalIssuer, missing: string[]): void {
  if (!issuer.cnpj) missing.push("the entity's CNPJ");
  if (!digitsOf(issuer.settings.municipalityCode)) missing.push("the entity's IBGE municipality code in its Brazil settings");
  if (!issuer.settings.inscricaoMunicipal) missing.push("the entity's Inscrição Municipal in its Brazil settings");
}

function tomadorAddress(counterparty: BrFiscalCounterparty) {
  const { street, number } = splitStreet(counterparty.address.line1);
  return {
    logradouro: street || undefined,
    numero: street ? number : undefined,
    complemento: counterparty.address.line2,
    bairro: counterparty.address.county,
    codigo_municipio: counterparty.fiscal.municipalityCode,
    uf: counterparty.address.state?.toUpperCase(),
    cep: digitsOf(counterparty.address.postalCode) || undefined,
  };
}

function requireDomesticTomador(counterparty: BrFiscalCounterparty, missing: string[]) {
  if (isForeign(counterparty.address.country)) {
    throw new BrPayloadError('An NFS-e to a customer abroad (exportação de serviços) is not supported yet: issue it in the provider or municipal portal');
  }
  const id = counterpartyId(counterparty);
  if (!id) missing.push("the customer's CNPJ or CPF");
  return id;
}

/** The invoice's notes and number as the NFS-e's complementary information. */
function serviceNotes(document: BrFiscalDocument): string | undefined {
  const parts = [...(document.number ? [`Fatura ${document.number}`] : []), ...(document.notes?.trim() ? [document.notes.trim()] : [])];
  return parts.length > 0 ? parts.join(' | ').slice(0, 2000) : undefined;
}

/**
 * NFS-e Nacional (DPS, `POST /v2/nfsen`): flat fields. The national environment
 * works the ISS out; the entity's Simples Nacional option and the retentions
 * are what this reports. A credit note has no NFS-e: a service invoice is
 * cancelled (or replaced), so it is refused before it gets here.
 */
export function buildNfsenPayload(args: NfsePayloadArgs): FocusRecord {
  const { now, issuer, counterparty, document, taxes, dpsNumber } = args;
  const missing: string[] = [];
  requireServiceIssuer(issuer, missing);
  const id = requireDomesticTomador(counterparty, missing);
  const service = summarizeService(args, missing);
  const nationalCode = service.serviceCode ? nationalServiceCode(service.serviceCode) : null;
  if (service.serviceCode && !nationalCode) missing.push(`the service code "${service.serviceCode}" is not an LC 116 item`);
  if (dpsNumber === undefined) missing.push('the DPS number');
  if (missing.length > 0) throw new BrPayloadError('The NFS-e is missing data', [...new Set(missing)]);

  const simples = isSimplesRegime(issuer.regime);
  const withheld = withholdingTotals(taxes.withheld);
  const pisCofinsWithheld = withheld.pis > 0 || withheld.cofins > 0 || withheld.csll > 0;
  const municipality = digitsOf(issuer.settings.municipalityCode);
  const emission = brasiliaIso(now);
  // The competência cannot be after the emission.
  const competence = document.issueDate > emission.slice(0, 10) ? emission.slice(0, 10) : document.issueDate;
  const tomador = tomadorAddress(counterparty);
  const hasIbsCbs = taxes.lines.some((rows) => rows.some((r) => r.component === 'cbs' || r.component === 'ibs'));
  const first = args.lines[0];

  let issTaxation = 1;
  if (service.exportService) issTaxation = 3;
  else if (service.exempt) issTaxation = 4;

  return compact({
    data_emissao: emission,
    data_competencia: competence,
    serie_dps: issuer.settings.dpsSeries ?? 1,
    numero_dps: dpsNumber,
    emitente_dps: 1,
    codigo_municipio_emissora: Number.parseInt(municipality, 10),
    cnpj_prestador: issuer.cnpj,
    inscricao_municipal_prestador: issuer.settings.inscricaoMunicipal,
    codigo_municipio_prestador: Number.parseInt(municipality, 10),
    codigo_opcao_simples_nacional: issuer.regime === 'mei' ? 2 : simples ? 3 : 1,
    regime_tributario_simples_nacional: simples ? 1 : undefined,
    regime_especial_tributacao: 0,
    ...(id?.kind === 'cnpj' ? { cnpj_tomador: id.value } : {}),
    ...(id?.kind === 'cpf' ? { cpf_tomador: id.value } : {}),
    razao_social_tomador: counterparty.name.slice(0, 150),
    inscricao_municipal_tomador: counterparty.fiscal.inscricaoMunicipal,
    codigo_municipio_tomador: tomador.codigo_municipio ? Number.parseInt(tomador.codigo_municipio, 10) : undefined,
    cep_tomador: tomador.cep,
    logradouro_tomador: tomador.logradouro,
    numero_tomador: tomador.numero,
    complemento_tomador: tomador.complemento,
    bairro_tomador: tomador.bairro,
    email_tomador: counterparty.email?.slice(0, 80),
    codigo_municipio_prestacao: Number.parseInt(municipality, 10),
    codigo_tributacao_nacional_iss: nationalCode,
    codigo_nbs: service.nbs,
    descricao_servico: service.description,
    informacoes_complementares: serviceNotes(document),
    valor_servico: service.amount,
    tributacao_iss: issTaxation,
    tipo_retencao_iss: withheld.iss > 0 ? 2 : 1,
    // The Simples Nacional provider's ISS is inside its DAS: no rate is informed.
    percentual_aliquota_relativa_municipio: !simples && issTaxation === 1 ? service.issRate : undefined,
    ...(pisCofinsWithheld
      ? {
          situacao_tributaria_pis_cofins: '01',
          base_calculo_pis_cofins: service.amount,
          aliquota_pis: 0.65,
          aliquota_cofins: 3,
          valor_pis: withheld.pis,
          valor_cofins: withheld.cofins,
          tipo_retencao_pis_cofins: 3,
          valor_csll: withheld.csll,
        }
      : {}),
    valor_irrf: withheld.irrf > 0 ? withheld.irrf : undefined,
    valor_cp: withheld.inss > 0 ? withheld.inss : undefined,
    ...(hasIbsCbs
      ? {
          finalidade_emissao: 0,
          consumidor_final: document.fiscal.finalConsumer ? 1 : 0,
          indicador_destinatario: 0,
          ibs_cbs_situacao_tributaria: first?.fiscal.ibsCbsCst ?? '000',
          ibs_cbs_classificacao_tributaria: first?.fiscal.cClassTrib ?? '000001',
        }
      : {}),
  });
}

/**
 * Municipal NFS-e (`POST /v2/nfse`): nested prestador / tomador / servico
 * objects, ABRASF-style. The ISS rate goes in as a percentage (3 for 3%);
 * municipalities differ, so check one in homologação before relying on it.
 */
export function buildNfsePayload(args: BuildPayloadArgs): FocusRecord {
  const { now, issuer, counterparty, document, taxes } = args;
  const missing: string[] = [];
  requireServiceIssuer(issuer, missing);
  const id = requireDomesticTomador(counterparty, missing);
  const service = summarizeService(args, missing);
  const itemCode = service.serviceCode ? municipalServiceItem(service.serviceCode) : null;
  if (service.serviceCode && !itemCode) missing.push(`the service code "${service.serviceCode}" is not an LC 116 item`);
  if (missing.length > 0) throw new BrPayloadError('The NFS-e is missing data', [...new Set(missing)]);

  const simples = isSimplesRegime(issuer.regime);
  const withheld = withholdingTotals(taxes.withheld);
  const municipality = digitsOf(issuer.settings.municipalityCode);
  const rate = service.issRate ?? issuer.settings.issRate;
  const address = tomadorAddress(counterparty);

  return compact({
    data_emissao: brasiliaIso(now),
    natureza_operacao: service.exempt ? '3' : '1',
    optante_simples_nacional: simples,
    prestador: compact({ cnpj: issuer.cnpj, inscricao_municipal: issuer.settings.inscricaoMunicipal, codigo_municipio: municipality }),
    tomador: compact({
      ...(id?.kind === 'cnpj' ? { cnpj: id.value } : {}),
      ...(id?.kind === 'cpf' ? { cpf: id.value } : {}),
      razao_social: counterparty.name.slice(0, 115),
      inscricao_municipal: counterparty.fiscal.inscricaoMunicipal,
      email: counterparty.email?.slice(0, 80),
      endereco: compact(address),
    }),
    servico: compact({
      valor_servicos: service.amount,
      iss_retido: withheld.iss > 0,
      valor_iss: simples ? undefined : service.issAmount,
      valor_iss_retido: withheld.iss > 0 ? withheld.iss : undefined,
      aliquota: rate,
      valor_pis: withheld.pis > 0 ? withheld.pis : undefined,
      valor_cofins: withheld.cofins > 0 ? withheld.cofins : undefined,
      valor_csll: withheld.csll > 0 ? withheld.csll : undefined,
      valor_ir: withheld.irrf > 0 ? withheld.irrf : undefined,
      valor_inss: withheld.inss > 0 ? withheld.inss : undefined,
      item_lista_servico: itemCode,
      codigo_cnae: digitsOf(issuer.settings.cnae) || undefined,
      codigo_tributario_municipio: issuer.settings.codigoTributarioMunicipio,
      discriminacao: [service.description, serviceNotes(document)].filter(Boolean).join('\n').slice(0, 2000),
      codigo_municipio: municipality,
    }),
  });
}
