/**
 * NF-e received from suppliers: fetched from Focus NFe by the entity's CNPJ
 * (incremental, by `versao`) or uploaded as XML, kept in received_fiscal_documents,
 * acknowledged with a manifestação do destinatário, and turned into draft bills.
 *
 * Focus only has the full XML once the buyer has declared "ciência", so a
 * freshly received note is a summary (issuer, total, key) until then.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { brProfileOf, brRegimeOf, isSimplesRegime, normalizeCnpj } from '@weldsuite/books-domain/jurisdictions/br';
import type { Env } from '../../types';
import { nextEntityNumber, resolveEntityBaseCurrency } from '../../lib/entity-context';
import { calculateDocumentTax, type DocumentTaxItem } from '../accounting-tax-resolve';
import { draftRate } from '../accounting-fx';
import { salesTaxRuntimeFromEnv } from '../sales-tax/runtime';
import { FiscalDocumentError } from './errors';
import { FiscalProviderError, type FocusClient, type FocusEnvironment, type FocusRecord } from './focus-client';
import { requireFiscalEntity } from './fiscal-documents';
import { parseNfeXml, XmlParseError, type ParsedNfe } from './nfe-xml';
import { fiscalEnvironmentOf, fiscalSettingsOf, focusClientFor } from './settings';

export type ReceivedFiscalDocumentRow = typeof schema.receivedFiscalDocuments.$inferSelect;
type EntityRow = typeof schema.entities.$inferSelect;

/** Pages of 100 per sync call, and XML downloads per call, so one request stays inside the worker's subrequest budget. */
const MAX_PAGES = 5;
const MAX_XML_FETCHES = 25;
/** Largest XML accepted (an NF-e of 990 items is far smaller). */
export const MAX_NFE_XML_BYTES = 2 * 1024 * 1024;

export const MANIFESTATION_TYPES = ['ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada'] as const;
export type ManifestationType = (typeof MANIFESTATION_TYPES)[number];

function entityCnpj(entity: EntityRow): string {
  const identifiers = (entity.taxIdentifiers ?? {}) as { vatNumber?: string };
  const cnpj = identifiers.vatNumber ? normalizeCnpj(identifiers.vatNumber) : '';
  if (!cnpj) throw new FiscalDocumentError("Set the entity's CNPJ before fetching received NF-e");
  return cnpj;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Series and number are inside the 44-digit key: UF(2) AAMM(4) CNPJ(14) modelo(2) série(3) número(9) ... */
function seriesAndNumberOf(accessKey: string): { series: string; number: string } {
  const strip = (v: string) => v.replace(/^0+/, '') || '0';
  return { series: strip(accessKey.slice(22, 25)), number: strip(accessKey.slice(25, 34)) };
}

function manifestationOf(value: unknown): string | null {
  const text = str(value);
  return text && text !== 'nulo' ? text : null;
}

// --- Reading an XML into a row ------------------------------------------------------------------

/** The columns a parsed NF-e fills. */
function parsedColumns(parsed: ParsedNfe, xml: string) {
  return {
    accessKey: parsed.accessKey,
    issuerTaxId: parsed.issuer.taxId?.slice(0, 14) ?? null,
    issuerName: parsed.issuer.name?.slice(0, 255) ?? null,
    number: parsed.number?.slice(0, 20) ?? null,
    series: parsed.series?.slice(0, 5) ?? null,
    issueDate: parsed.issueDate,
    total: parsed.total.toFixed(2),
    xml,
  };
}

async function loadReceived(db: Database, entityId: string, accessKey: string): Promise<ReceivedFiscalDocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.receivedFiscalDocuments)
    .where(and(eq(schema.receivedFiscalDocuments.entityId, entityId), eq(schema.receivedFiscalDocuments.accessKey, accessKey)))
    .limit(1);
  return row;
}

export async function getReceivedFiscalDocument(db: Database, entityId: string, id: string): Promise<ReceivedFiscalDocumentRow> {
  const [row] = await db
    .select()
    .from(schema.receivedFiscalDocuments)
    .where(and(eq(schema.receivedFiscalDocuments.id, id), eq(schema.receivedFiscalDocuments.entityId, entityId)))
    .limit(1);
  if (!row) throw new FiscalDocumentError('Received fiscal document not found', 404);
  return row;
}

/** Store a note's XML on its row, parsed. A file that cannot be read keeps the raw XML and says why in `parsed.parseError`. */
async function attachXml(db: Database, row: ReceivedFiscalDocumentRow, xml: string): Promise<ReceivedFiscalDocumentRow> {
  const existing = (row.parsed ?? {}) as Record<string, unknown>;
  let patch: Partial<typeof schema.receivedFiscalDocuments.$inferInsert>;
  try {
    const parsed = parseNfeXml(xml);
    if (parsed.accessKey !== row.accessKey) {
      throw new XmlParseError('The XML belongs to a different NF-e than this row');
    }
    const { accessKey, ...columns } = parsedColumns(parsed, xml);
    patch = { ...columns, parsed: { ...existing, nfe: parsed, parseError: null } };
  } catch (err) {
    if (!(err instanceof XmlParseError)) throw err;
    patch = { xml, parsed: { ...existing, parseError: err.message } };
  }
  const [saved] = await db
    .update(schema.receivedFiscalDocuments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.receivedFiscalDocuments.id, row.id))
    .returning();
  return saved;
}

// --- Sync ---------------------------------------------------------------------------------------

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  xmlFetched: number;
  /** More notes are waiting: call again. */
  hasMore: boolean;
  version: number;
}

async function upsertSummary(db: Database, entityId: string, item: FocusRecord): Promise<{ row: ReceivedFiscalDocumentRow; created: boolean } | null> {
  const accessKey = str(item.chave_nfe)?.replace(/^NFe/i, '');
  if (!accessKey || !/^\d{44}$/.test(accessKey)) return null;
  const existing = await loadReceived(db, entityId, accessKey);
  const { series, number } = seriesAndNumberOf(accessKey);
  const summary = {
    situacao: str(item.situacao) ?? null,
    tipoNfe: str(item.tipo_nfe) ?? null,
    nfeCompleta: item.nfe_completa === true,
    versao: typeof item.versao === 'number' ? item.versao : Number.parseInt(str(item.versao) ?? '', 10) || null,
    digestValue: str(item.digest_value) ?? null,
    cancelledAt: str(item.data_cancelamento) ?? null,
    cancelReason: str(item.justificativa_cancelamento) ?? null,
    correction: str(item.carta_correcao) ?? null,
  };
  const columns = {
    issuerTaxId: str(item.documento_emitente)?.slice(0, 14) ?? null,
    issuerName: str(item.nome_emitente)?.slice(0, 255) ?? null,
    issueDate: str(item.data_emissao)?.slice(0, 10) ?? null,
    total: str(item.valor_total) ?? null,
    manifestation: manifestationOf(item.manifestacao_destinatario),
  };

  if (existing) {
    const [saved] = await db
      .update(schema.receivedFiscalDocuments)
      .set({
        ...columns,
        // The XML's own numbers are better than the key's; keep them once there.
        ...(existing.xml ? {} : { number, series }),
        parsed: { ...((existing.parsed ?? {}) as Record<string, unknown>), summary },
        updatedAt: new Date(),
      })
      .where(eq(schema.receivedFiscalDocuments.id, existing.id))
      .returning();
    return { row: saved, created: false };
  }
  const [created] = await db
    .insert(schema.receivedFiscalDocuments)
    .values({
      id: generateId('rfd'),
      entityId,
      kind: 'nfe',
      accessKey,
      number,
      series,
      status: 'new',
      source: 'focus_nfe',
      parsed: { summary },
      ...columns,
    })
    .returning();
  return { row: created, created: true };
}

/**
 * Fetch the NF-e received since the last sync and store them. The high-water
 * mark (Focus `versao`) lives in the entity's jurisdiction settings, per
 * environment: a homologação number means nothing in production.
 */
export async function syncReceivedFiscalDocuments(
  db: Database,
  env: Env,
  entityId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<SyncResult> {
  const entity = await requireFiscalEntity(db, entityId);
  const settings = fiscalSettingsOf(entity);
  const environment = fiscalEnvironmentOf(settings);
  const client = await focusClientFor(entity, env, environment, options.fetch);
  const cnpj = entityCnpj(entity);

  let version = settings.receivedNfeVersionEnv === environment ? (settings.receivedNfeVersion ?? 0) : 0;
  const result: SyncResult = { fetched: 0, created: 0, updated: 0, xmlFetched: 0, hasMore: false, version };

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.listReceived({ cnpj, versao: version || undefined });
    if (batch.items.length === 0) break;
    let highest = version;
    for (const item of batch.items) {
      const versao = await syncReceivedItem(db, client, entityId, item, result);
      if (Number.isFinite(versao)) highest = Math.max(highest, versao);
    }
    version = highest;
    if (batch.items.length >= batch.totalCount) {
      // Everything up to Focus' own high-water mark has been seen.
      version = Math.max(version, batch.maxVersion ?? 0);
      break;
    }
    if (page === MAX_PAGES - 1) result.hasMore = true;
  }

  result.version = version;
  await saveReceivedVersion(db, entity, settings, environment, version);
  return result;
}

/**
 * Store one note of a listing, and its XML once Focus has it, counting it in
 * `result`. Returns the note's `versao`: NaN when it has none or was skipped.
 */
async function syncReceivedItem(db: Database, client: FocusClient, entityId: string, item: FocusRecord, result: SyncResult): Promise<number> {
  const stored = await upsertSummary(db, entityId, item);
  if (!stored) return Number.NaN;
  result.fetched++;
  if (stored.created) result.created++;
  else result.updated++;
  const versao = typeof item.versao === 'number' ? item.versao : Number.parseInt(str(item.versao) ?? '', 10);

  if (item.nfe_completa === true && !stored.row.xml && result.xmlFetched < MAX_XML_FETCHES) {
    const xml = await client.receivedXml(stored.row.accessKey);
    if (xml) {
      await attachXml(db, stored.row, xml);
      result.xmlFetched++;
    }
  }
  return versao;
}

/** Keep the high-water mark of the environment in the entity's jurisdiction settings, when it moved. */
async function saveReceivedVersion(
  db: Database,
  entity: EntityRow,
  settings: ReturnType<typeof fiscalSettingsOf>,
  environment: FocusEnvironment,
  version: number,
): Promise<void> {
  if (version === (settings.receivedNfeVersion ?? 0) && settings.receivedNfeVersionEnv === environment) return;
  await db
    .update(schema.entities)
    .set({
      jurisdictionSettings: { ...settings, receivedNfeVersion: version, receivedNfeVersionEnv: environment } as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(schema.entities.id, entity.id));
}

// --- Upload ---------------------------------------------------------------------------------------

/** Store an NF-e from its XML. The note must be addressed to the entity's CNPJ. */
export async function importNfeXml(
  db: Database,
  entityId: string,
  xml: string,
): Promise<{ row: ReceivedFiscalDocumentRow; created: boolean }> {
  if (new TextEncoder().encode(xml).length > MAX_NFE_XML_BYTES) {
    throw new FiscalDocumentError('The XML file is too large');
  }
  const entity = await requireFiscalEntity(db, entityId);
  let parsed: ParsedNfe;
  try {
    parsed = parseNfeXml(xml);
  } catch (err) {
    if (err instanceof XmlParseError) throw new FiscalDocumentError(`The file is not a readable NF-e: ${err.message}`);
    throw err;
  }
  const cnpj = entityCnpj(entity);
  if (parsed.recipient.taxId && normalizeCnpj(parsed.recipient.taxId) !== cnpj) {
    throw new FiscalDocumentError(`This NF-e is addressed to ${parsed.recipient.taxId}, not to this entity (${cnpj})`);
  }

  const existing = await loadReceived(db, entityId, parsed.accessKey);
  if (existing) {
    if (existing.status === 'imported') {
      throw new FiscalDocumentError('This NF-e was already turned into a bill', 409, { receivedDocumentId: existing.id });
    }
    return { row: await attachXml(db, existing, xml), created: false };
  }
  const [row] = await db
    .insert(schema.receivedFiscalDocuments)
    .values({
      id: generateId('rfd'),
      entityId,
      kind: 'nfe',
      status: 'new',
      source: 'upload',
      parsed: { nfe: parsed },
      ...parsedColumns(parsed, xml),
    })
    .returning();
  return { row, created: true };
}

// --- Manifestação ---------------------------------------------------------------------------------

/** Declare ciência, confirmação, desconhecimento or operação não realizada on a received NF-e. */
export async function manifestReceivedDocument(
  db: Database,
  env: Env,
  doc: ReceivedFiscalDocumentRow,
  type: ManifestationType,
  reason: string | undefined,
  options: { fetch?: typeof fetch } = {},
): Promise<ReceivedFiscalDocumentRow> {
  const entity = await requireFiscalEntity(db, doc.entityId);
  const client = await focusClientFor(entity, env, fiscalEnvironmentOf(fiscalSettingsOf(entity)), options.fetch);
  const res = await client.manifest(doc.accessKey, type, reason);
  if (res.data.status !== 'evento_registrado') {
    throw new FiscalDocumentError(str(res.data.mensagem_sefaz) ?? 'The manifestation was not accepted', 400, {
      provider: 'focus_nfe',
      statusSefaz: str(res.data.status_sefaz) ?? null,
    });
  }
  const [saved] = await db
    .update(schema.receivedFiscalDocuments)
    .set({ manifestation: type, updatedAt: new Date() })
    .where(eq(schema.receivedFiscalDocuments.id, doc.id))
    .returning();

  // Ciência unlocks the full XML; ask for it right away (it may take a moment to appear, the next sync gets it then).
  if (type === 'ciencia' && !saved.xml) {
    try {
      const xml = await client.receivedXml(saved.accessKey);
      if (xml) return await attachXml(db, saved, xml);
    } catch (err) {
      if (!(err instanceof FiscalProviderError)) throw err;
    }
  }
  return saved;
}

export async function ignoreReceivedDocument(db: Database, doc: ReceivedFiscalDocumentRow): Promise<ReceivedFiscalDocumentRow> {
  if (doc.status === 'imported') throw new FiscalDocumentError('This NF-e was already turned into a bill', 409);
  const [saved] = await db
    .update(schema.receivedFiscalDocuments)
    .set({ status: 'ignored', updatedAt: new Date() })
    .where(eq(schema.receivedFiscalDocuments.id, doc.id))
    .returning();
  return saved;
}

// --- Bill -----------------------------------------------------------------------------------------

/** The supplier's accounting contact whose company has this CNPJ, if any. */
export async function findSupplierByTaxId(db: Database, taxId: string): Promise<string | null> {
  const wanted = normalizeCnpj(taxId);
  const [party] = await db
    .select({ id: schema.parties.id })
    .from(schema.parties)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.parties.companyId))
    .where(
      and(
        isNull(schema.parties.deletedAt),
        sql`upper(regexp_replace(${schema.companies.vatNumber}, '[^0-9A-Za-z]', '', 'g')) = ${wanted}`,
      ),
    )
    .limit(1);
  return party?.id ?? null;
}

/** The unit price of a line: the NF-e's own when it multiplies out to the line total, else the total spread over the quantity. */
function unitPriceOf(item: ParsedNfe['items'][number]): number {
  if (item.quantity <= 0) return item.total;
  if (Math.abs(item.quantity * item.unitPrice - item.total) <= 0.01) return item.unitPrice;
  return Math.round((item.total / item.quantity) * 10000) / 10000;
}

/** First digit of an entry CFOP by the first digit of the supplier's: 5 -> 1, 6 -> 2, 7 -> 3. */
const ENTRY_CFOP_FIRST_DIGIT: Record<string, string | undefined> = { '5': '1', '6': '2', '7': '3' };

/** The entry CFOP of a purchase: the supplier's 5xxx / 6xxx / 7xxx becomes 1xxx / 2xxx / 3xxx. */
export function entryCfop(cfop: string): string | null {
  if (!/^\d{4}$/.test(cfop)) return null;
  if (/^[123]/.test(cfop)) return cfop;
  const first = ENTRY_CFOP_FIRST_DIGIT[cfop[0]];
  return first ? `${first}${cfop.slice(1)}` : null;
}

type BillLine = DocumentTaxItem & { description: string };

/** A bill line for an NF-e item, with its NCM, entry CFOP and the ICMS / IPI rates the supplier charged. */
function billLineOf(item: ParsedNfe['items'][number], idx: number, taxRateId: string | null): BillLine {
  const gross = item.total;
  const discountPercent = gross > 0 && item.discount > 0 ? ((item.discount / gross) * 100).toFixed(2) : '0';
  return {
    id: generateId('bli'),
    description: item.description || `Item ${idx + 1}`,
    quantity: String(item.quantity || 1),
    unitPrice: String(unitPriceOf(item)),
    discountPercent,
    sortOrder: idx,
    taxRateId,
    ncm: /^\d{8}$/.test(item.ncm) ? item.ncm : null,
    cfop: entryCfop(item.cfop),
    fiscalData: {
      ...(item.origin ? { origin: item.origin } : {}),
      icmsRate: item.icms.rate,
      ipiRate: item.ipi.rate,
    },
  };
}

/** The bill lines of an NF-e: one per item, then ICMS ST, freight, insurance and other expenses when there are any. */
function billLinesOf(parsed: ParsedNfe, taxRateId: string | null): BillLine[] {
  const lines = parsed.items.map((item, idx) => billLineOf(item, idx, taxRateId));
  const extras: Array<[string, number]> = [
    ['ICMS substituição tributária', parsed.icmsSt],
    ['Frete', parsed.freight],
    ['Seguro', parsed.insurance],
    ['Outras despesas acessórias', parsed.other],
  ];
  for (const [description, amount] of extras) {
    if (amount > 0) {
      lines.push({ id: generateId('bli'), description, quantity: '1', unitPrice: amount.toFixed(2), discountPercent: '0', sortOrder: lines.length, taxRateId: null });
    }
  }
  return lines;
}

export interface CreateBillArgs {
  /** Required when no contact has the issuer's CNPJ. */
  contactId?: string;
  expenseAccountId?: string;
  /** yyyy-mm-dd; else the first installment's due date, else the issue date. */
  dueDate?: string;
  userId?: string | null;
}

/**
 * A draft bill from a received NF-e's XML: one line per item with its NCM,
 * the entry CFOP and the ICMS / IPI rates the supplier charged (which the BR
 * engine turns into credits for a regime that takes them), plus lines for ICMS
 * ST, freight, insurance and other expenses, so the bill matches the NF-e's
 * total. The note is linked to the bill and marked imported.
 */
export async function createBillFromReceived(
  db: Database,
  env: Env,
  entity: EntityRow,
  doc: ReceivedFiscalDocumentRow,
  args: CreateBillArgs,
) {
  if (doc.status === 'imported') throw new FiscalDocumentError('This NF-e was already turned into a bill', 409, { billId: doc.billId });
  const parsed = (doc.parsed as { nfe?: ParsedNfe } | null)?.nfe;
  if (!parsed || parsed.items.length === 0) {
    throw new FiscalDocumentError('The full XML of this NF-e is not available yet. Send a ciência manifestation (or upload the XML), then try again.');
  }

  let contactId = args.contactId ?? null;
  if (!contactId && parsed.issuer.taxId) contactId = await findSupplierByTaxId(db, parsed.issuer.taxId);
  if (!contactId) {
    throw new FiscalDocumentError(
      `No contact has the CNPJ ${parsed.issuer.taxId ?? ''} of the issuer ${parsed.issuer.name ?? ''}: create the supplier, or pass contactId`.replace(/\s+/g, ' '),
    );
  }
  const [contact] = await db
    .select({ id: schema.parties.id, displayName: schema.parties.displayName, role: schema.parties.role })
    .from(schema.parties)
    .where(and(eq(schema.parties.id, contactId), isNull(schema.parties.deletedAt)))
    .limit(1);
  if (!contact) throw new FiscalDocumentError('Contact not found', 404);

  const regime = brRegimeOf(entity.taxClassification);
  const takesCredits = !isSimplesRegime(regime);
  const hasCredit = parsed.items.some((i) => i.icms.value > 0 || i.pis.value > 0 || i.cofins.value > 0 || i.ipi.value > 0);
  const profileName = takesCredits && hasCredit ? 'compra_revenda_credito' : 'compra_sem_credito';
  const rates = await db
    .select()
    .from(schema.taxRates)
    .where(and(eq(schema.taxRates.entityId, entity.id), eq(schema.taxRates.isActive, true), isNull(schema.taxRates.deletedAt)));
  const purchaseRate = rates.find((r) => brProfileOf(r.jurisdictionMetadata)?.profile === profileName);

  const billId = generateId('bil');
  const lines = billLinesOf(parsed, purchaseRate?.id ?? null);

  const baseCurrency = await resolveEntityBaseCurrency(db, entity.id);
  const issueDate = new Date(`${parsed.issueDate ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const dueDay = args.dueDate ?? parsed.installments.find((i) => i.dueDate)?.dueDate ?? parsed.issueDate ?? issueDate.toISOString().slice(0, 10);
  const dueDate = new Date(`${dueDay}T12:00:00Z`);
  const billNumber = (await nextEntityNumber(db, entity.id, 'bill')).formatted;
  const fiscalData = { accessKey: parsed.accessKey };

  const totals = await calculateDocumentTax(db, {
    entityId: entity.id,
    direction: 'purchase',
    items: lines,
    runtime: salesTaxRuntimeFromEnv(env),
    document: {
      kind: 'bill',
      documentId: billId,
      documentNumber: billNumber,
      contactId,
      issueDate,
      currency: baseCurrency,
      fiscalData,
    },
  });
  const { processedItems, taxBreakdown, salesTax, taxWarnings, ...billTotals } = totals;

  const now = new Date();
  const mismatch = Math.abs(Number.parseFloat(billTotals.total) - parsed.total) > 0.05;
  const bill = {
    id: billId,
    entityId: entity.id,
    billNumber,
    type: 'standard' as const,
    status: 'draft' as const,
    contactId,
    contactName: contact.displayName,
    issueDate,
    dueDate,
    currency: baseCurrency,
    exchangeRate: await draftRate(db, { baseCurrency, currency: baseCurrency, date: issueDate }),
    ...billTotals,
    taxBreakdown,
    amountPaid: '0',
    externalReference: parsed.number ? `${parsed.series ?? '1'}/${parsed.number}` : null,
    reference: `NF-e ${parsed.accessKey}`,
    internalNotes: mismatch
      ? `Total of the NF-e is R$ ${parsed.total.toFixed(2)}; the bill adds up to R$ ${billTotals.total}. Check the taxes before approving.`
      : null,
    expenseAccountId: args.expenseAccountId ?? null,
    fiscalData,
    approvalStatus: 'pending' as const,
    createdBy: args.userId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const itemRecords = lines.map((line, idx) => ({
    id: line.id as string,
    entityId: entity.id,
    billId,
    description: line.description,
    quantity: line.quantity ?? '1',
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent ?? '0',
    taxRateId: processedItems[idx].taxRateId,
    taxRate: processedItems[idx].taxRate,
    taxAmount: processedItems[idx].taxAmount,
    lineTotal: processedItems[idx].lineTotal,
    lineTotalWithTax: processedItems[idx].lineTotalWithTax,
    accountId: args.expenseAccountId ?? null,
    sortOrder: idx,
    ncm: line.ncm ?? null,
    cfop: line.cfop ?? null,
    fiscalData: line.fiscalData ?? null,
    createdAt: now,
    updatedAt: now,
  }));

  await db.insert(schema.bills).values(bill);
  if (itemRecords.length > 0) await db.insert(schema.billItems).values(itemRecords);
  // The first bill of a contact makes it a supplier (none -> supplier, customer -> both).
  const role = contact.role ?? 'none';
  if (role === 'none' || role === 'customer') {
    await db
      .update(schema.parties)
      .set({ role: role === 'none' ? 'supplier' : 'both', updatedAt: now })
      .where(eq(schema.parties.id, contactId));
  }
  const [linked] = await db
    .update(schema.receivedFiscalDocuments)
    .set({ status: 'imported', billId, updatedAt: now })
    .where(eq(schema.receivedFiscalDocuments.id, doc.id))
    .returning();
  return { bill: { ...bill, items: itemRecords }, document: linked, warnings: taxWarnings ?? [] };
}

/** The data an entity event carries for a received document: no XML. */
export function receivedEventData(doc: ReceivedFiscalDocumentRow): Record<string, unknown> {
  return {
    id: doc.id,
    entityId: doc.entityId,
    kind: doc.kind,
    accessKey: doc.accessKey,
    issuerName: doc.issuerName,
    number: doc.number,
    total: doc.total,
    status: doc.status,
    manifestation: doc.manifestation,
    billId: doc.billId,
  };
}
