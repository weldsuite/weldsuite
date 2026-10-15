/**
 * What a Brazilian invoice prints beyond its lines: the Pix QR code for the
 * amount due, the legally required statements of the entity's regime and the
 * authorised NF-e / NFS-e it belongs to. Mirrors the server-rendered invoice
 * (`books-api/src/services/br-invoice-render.ts`, `accounting-compliance.ts`).
 */
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { isBrTaxRegime } from './br-entity';
import { buildPixPayload } from './pix';

/** Statements an ME/EPP in the Simples Nacional must print on its documents (LC 123/2006 art. 23). */
export const BR_NOTICE_SIMPLES =
  'Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI.';
export const BR_NOTICE_MEI = 'Documento emitido por MEI optante pelo SIMEI.';
export const BR_NOTICE_EXPORT = 'Operação de exportação: não incidência de ICMS, IPI, PIS, COFINS e ISS.';
/** WeldBooks' invoice is a commercial document: the fiscal one is the NF-e / NFS-e. */
export const BR_NOTICE_NOT_FISCAL = 'Este documento não substitui a nota fiscal eletrônica (NF-e / NFS-e).';

export interface BrInvoiceEntity {
  name: string;
  legalName?: string | null;
  baseCurrency?: string | null;
  taxClassification?: string | null;
  jurisdictionSettings?: Record<string, unknown> | null;
}

function setting(entity: BrInvoiceEntity, key: string): string {
  const value = entity.jurisdictionSettings?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** The Pix key, BR Code and amount of an unpaid BRL invoice of an entity with a Pix key; null otherwise. */
export function brPixFor(
  invoice: Pick<InvoiceWithTax, 'type' | 'status' | 'currency' | 'balanceDue' | 'total' | 'invoiceNumber' | 'id'>,
  entity: BrInvoiceEntity | null | undefined,
): { key: string; payload: string; amount: number } | null {
  if (!entity) return null;
  const key = setting(entity, 'pixKey');
  const currency = (invoice.currency ?? entity.baseCurrency ?? '').toUpperCase();
  const amount = Number.parseFloat(invoice.balanceDue ?? invoice.total ?? '0');
  const open = invoice.type !== 'credit_note' && invoice.status !== 'draft' && invoice.status !== 'cancelled';
  // parseFloat can yield NaN, which the positive-amount check must also reject.
  if (!key || currency !== 'BRL' || !open || Number.isNaN(amount) || amount <= 0) return null;
  try {
    const payload = buildPixPayload({
      key,
      merchantName: entity.legalName || entity.name,
      merchantCity: setting(entity, 'pixCity') || setting(entity, 'municipalityName') || 'BRASIL',
      amount,
      txid: invoice.invoiceNumber ?? invoice.id,
    });
    return { key, payload, amount };
  } catch {
    return null;
  }
}

/** The statements to print on an invoice of this entity (Portuguese: they are legal wording). */
export function brComplianceNotices(entity: BrInvoiceEntity | null | undefined, options: { hasExport?: boolean } = {}): string[] {
  const regime = isBrTaxRegime(entity?.taxClassification) ? entity?.taxClassification : 'simples_nacional';
  const notices: string[] = [];
  if (regime === 'simples_nacional') notices.push(BR_NOTICE_SIMPLES);
  if (regime === 'mei') notices.push(BR_NOTICE_MEI);
  if (options.hasExport) notices.push(BR_NOTICE_EXPORT);
  notices.push(BR_NOTICE_NOT_FISCAL);
  return notices;
}
