/**
 * Moneybird deliveries whose entity is not the record to import
 * (`isRoutedMoneybirdTopic`):
 *
 * - `document_*`: a purchase invoice or a receipt. The payload's
 *   `entity_type` says which when it names one; otherwise the document is read
 *   back as a purchase invoice, then as a receipt.
 * - `payment_*`: the payment. The sales invoice or document it belongs to is
 *   read back (what is paid, and its state, changed), and so is the bank line
 *   it was linked to.
 * - `financial_statement_*`: the statement. Its lines are the bank lines;
 *   Moneybird has no event of their own.
 *
 * Payments on external sales invoices (what WeldBooks itself sends to
 * Moneybird) and VAT documents, and documents WeldBooks doesn't import
 * (typeless, general journal), are left alone.
 */

import type { MoneybirdClient } from '@weldsuite/connectors';

export interface MoneybirdDeliveryTarget {
  syncName: string;
  records: Array<Record<string, unknown>>;
  forceDeleted: boolean;
}

const PURCHASE_INVOICES = 'moneybird-purchase-invoices';
const RECEIPTS = 'moneybird-receipts';
const SALES_INVOICES = 'moneybird-sales-invoices';
const MUTATIONS = 'moneybird-financial-mutations';

/** Moneybird ids are digits: anything else is not put into a request path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function idOf(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim();
  return SAFE_ID.test(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `entity_type` → the sync for that document; `'other'` for documents WeldBooks doesn't import; null when it doesn't say. */
function documentSyncFromType(entityType: unknown): string | null {
  if (typeof entityType !== 'string') return null;
  const type = entityType.toLowerCase().replace(/[^a-z]/g, '');
  if (type.endsWith('purchaseinvoice')) return PURCHASE_INVOICES;
  if (type.endsWith('receipt')) return RECEIPTS;
  if (type.endsWith('typelessdocument') || type.endsWith('generaljournaldocument')) return 'other';
  return null;
}

/** Whether the connection imports into this sync (on, and inbound). */
type Wants = (syncName: string) => boolean;

/** A document read back as a purchase invoice, else as a receipt; null when it is neither, or not imported. */
async function readDocument(client: MoneybirdClient, id: string, wants: Wants): Promise<MoneybirdDeliveryTarget | null> {
  if (!wants(PURCHASE_INVOICES) && !wants(RECEIPTS)) return null;
  const invoice = await client.getPurchaseInvoice(id);
  if (invoice) {
    return wants(PURCHASE_INVOICES) ? { syncName: PURCHASE_INVOICES, records: [invoice], forceDeleted: false } : null;
  }
  const receipt = await client.getReceipt(id);
  return receipt && wants(RECEIPTS) ? { syncName: RECEIPTS, records: [receipt], forceDeleted: false } : null;
}

async function documentTargets(
  client: MoneybirdClient,
  payload: Record<string, unknown>,
  entity: Record<string, unknown>,
  kind: string,
  wants: Wants,
): Promise<MoneybirdDeliveryTarget[]> {
  const hinted = documentSyncFromType(payload.entity_type);
  if (hinted === 'other') return [];
  if (kind === 'delete') {
    // Gone from Moneybird: removed under whichever kind WeldBooks has it as.
    return (hinted ? [hinted] : [PURCHASE_INVOICES, RECEIPTS])
      .filter(wants)
      .map((syncName) => ({ syncName, records: [entity], forceDeleted: true }));
  }
  if (hinted) return wants(hinted) ? [{ syncName: hinted, records: [entity], forceDeleted: false }] : [];
  const id = idOf(entity.id) ?? idOf(payload.entity_id);
  const found = id ? await readDocument(client, id, wants) : null;
  return found ? [found] : [];
}

async function paymentTargets(
  client: MoneybirdClient,
  entity: Record<string, unknown>,
  wants: Wants,
): Promise<MoneybirdDeliveryTarget[]> {
  const type = entity.invoice_type;
  if (type !== 'SalesInvoice' && type !== 'Document') return [];
  const targets: MoneybirdDeliveryTarget[] = [];
  const invoiceId = idOf(entity.invoice_id);
  if (invoiceId && type === 'SalesInvoice') {
    const invoice = wants(SALES_INVOICES) ? await client.getSalesInvoice(invoiceId) : null;
    if (invoice) targets.push({ syncName: SALES_INVOICES, records: [invoice], forceDeleted: false });
  } else if (invoiceId) {
    const found = await readDocument(client, invoiceId, wants);
    if (found) targets.push(found);
  }
  const mutationId = idOf(entity.financial_mutation_id);
  if (mutationId && wants(MUTATIONS)) {
    const mutations = await client.getFinancialMutations([mutationId]);
    if (mutations.length > 0) targets.push({ syncName: MUTATIONS, records: mutations, forceDeleted: false });
  }
  return targets;
}

function statementTargets(entity: Record<string, unknown>, kind: string, wants: Wants): MoneybirdDeliveryTarget[] {
  if (!wants(MUTATIONS)) return [];
  const lines = Array.isArray(entity.financial_mutations) ? entity.financial_mutations.filter(isRecord) : [];
  if (lines.length === 0) return [];
  const accountId = entity.financial_account_id;
  const records = lines.map((line) =>
    (line.financial_account_id === undefined || line.financial_account_id === null) && accountId !== undefined && accountId !== null
      ? { ...line, financial_account_id: accountId }
      : line,
  );
  return [{ syncName: MUTATIONS, records, forceDeleted: kind === 'delete' }];
}

/**
 * What a routed Moneybird delivery imports, per sync; Moneybird is read only
 * for syncs the connection imports (`wants`). Empty: nothing to import.
 */
export function moneybirdDeliveryTargets(args: {
  client: MoneybirdClient;
  topic: string;
  kind: string;
  payload: Record<string, unknown>;
  entity: Record<string, unknown>;
  wants: Wants;
}): Promise<MoneybirdDeliveryTarget[]> {
  const { client, topic, kind, payload, entity, wants } = args;
  if (topic.startsWith('document_')) return documentTargets(client, payload, entity, kind, wants);
  if (topic.startsWith('payment_')) return paymentTargets(client, entity, wants);
  if (topic.startsWith('financial_statement_')) return Promise.resolve(statementTargets(entity, kind, wants));
  return Promise.resolve([]);
}
