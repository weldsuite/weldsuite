/**
 * Electronic fiscal documents of a Brazilian invoice, through Focus NFe:
 * issue (NF-e for goods, NFS-e for services), refresh the status, cancel and
 * correct (carta de correção).
 *
 * One row of fiscal_documents per attempt. Issuing writes the row as
 * `processing` first, so a webhook that arrives before the POST returns finds
 * it, then sends the payload. A provider rejection keeps the row as `rejected`
 * (a new attempt gets a new row and a new provider reference); a network
 * failure keeps it as `error` and the next attempt asks Focus about it before
 * sending another, so a document is never issued twice.
 *
 * Functions here take a database and the worker env and know nothing of Hono:
 * the routes write the audit trail and publish the entity events.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  brProfileOf,
  brRegimeOf,
  computeBrDocumentTaxes,
  normalizeCnpj,
  type BrDocumentFiscalData,
} from '@weldsuite/books-domain/jurisdictions/br';
import { getJurisdictionFeatures } from '@weldsuite/books-domain/jurisdictions/registry';
import type { DocumentTaxLineInput, DocumentTaxRow } from '@weldsuite/books-domain/jurisdictions/types';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { getContactVatNumber } from '@weldsuite/books-domain/accounting-compliance';
import type { Env } from '../../types';
import { loadTaxRates } from '../accounting-document-posting';
import { FiscalDocumentError } from './errors';
import {
  accessKeyOf,
  FiscalProviderError,
  mapFocusStatus,
  type FocusClient,
  type FocusDocumentKind,
  type FocusEnvironment,
  type FocusRecord,
} from './focus-client';
import {
  buildNfePayload,
  buildNfsePayload,
  buildNfsenPayload,
  chooseFiscalKind,
  type BrFiscalCounterparty,
  type BrFiscalLine,
  type BuildPayloadArgs,
} from './payload';
import { fiscalEnvironmentOf, fiscalSettingsOf, focusClientFor } from './settings';

type EntityRow = typeof schema.entities.$inferSelect;
type InvoiceRow = typeof schema.invoices.$inferSelect;
type InvoiceItemRow = typeof schema.invoiceItems.$inferSelect;
export type FiscalDocumentRow = typeof schema.fiscalDocuments.$inferSelect;

/** Invoice statuses that are not issued as a fiscal document yet (drafts) or any more (cancelled). */
const NOT_ISSUABLE_STATUSES = new Set(['draft', 'cancelled']);

/** Request fields echoed back by Focus with `completa=1`: the row already holds our own request. */
const ECHOED_KEYS = ['requisicao_nota_fiscal', 'requisicao_cancelamento', 'requisicao_carta_correcao'];

/** The entity of a fiscal document request: it has to exist and be in a jurisdiction with fiscal documents (Brazil). */
export async function requireFiscalEntity(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new FiscalDocumentError(`Accounting entity ${entityId} not found`, 404);
  if (!getJurisdictionFeatures(entity.jurisdictionCode).fiscalDocuments) {
    throw new FiscalDocumentError('Fiscal documents (NF-e / NFS-e) are only available for Brazilian accounting entities');
  }
  return entity;
}

function num(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// --- Building the payload -------------------------------------------------------

export interface IssueContext {
  kind: FocusDocumentKind;
  args: BuildPayloadArgs;
}

async function loadCounterparty(db: Database, invoice: InvoiceRow): Promise<BrFiscalCounterparty> {
  const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, invoice.contactId)).limit(1);
  const brFiscal = (party?.brFiscal ?? {}) as BrFiscalCounterparty['fiscal'] & { taxId?: string };

  let identityName: string | null = null;
  if (party?.companyId) {
    const [company] = await db
      .select({ displayName: schema.companies.displayName })
      .from(schema.companies)
      .where(eq(schema.companies.id, party.companyId))
      .limit(1);
    identityName = company?.displayName ?? null;
  } else if (party?.personId) {
    const [person] = await db
      .select({ displayName: schema.people.displayName })
      .from(schema.people)
      .where(eq(schema.people.id, party.personId))
      .limit(1);
    identityName = person?.displayName ?? null;
  }

  const address =
    normalizePostalAddress(invoice.shippingAddress) ??
    normalizePostalAddress(invoice.billingAddress) ??
    normalizePostalAddress(party?.shippingAddress) ??
    normalizePostalAddress(party?.billingAddress) ??
    {};
  const taxId = (await getContactVatNumber(db, invoice.contactId)) ?? brFiscal.taxId ?? null;
  return {
    name: invoice.contactName || party?.displayName || identityName || '',
    email: invoice.contactEmail,
    taxId,
    address,
    fiscal: fiscalFieldsOf(brFiscal),
  };
}

/** A party's BR fiscal fields without its tax id, which the counterparty carries on its own. */
function fiscalFieldsOf({ taxId, ...fiscal }: BrFiscalCounterparty['fiscal'] & { taxId?: string }): BrFiscalCounterparty['fiscal'] {
  return fiscal;
}

function toFiscalLines(items: InvoiceItemRow[], rates: Awaited<ReturnType<typeof loadTaxRates>>): BrFiscalLine[] {
  return items.map((item) => {
    const quantity = num(item.quantity, 1);
    const unitPrice = num(item.unitPrice);
    const discountPercent = num(item.discountPercent);
    const gross = quantity * unitPrice;
    const lineTotal = item.lineTotal !== null ? num(item.lineTotal) : Math.round((gross - gross * (discountPercent / 100) + Number.EPSILON) * 100) / 100;
    const rate = item.taxRateId ? rates.get(item.taxRateId) : undefined;
    return {
      description: item.description,
      quantity,
      unitPrice,
      discountPercent,
      unit: item.unit,
      lineTotal,
      productCode: item.productId,
      ncm: item.ncm,
      cfop: item.cfop,
      fiscal: { ...((item.fiscalData ?? {}) as Record<string, unknown>), ...(item.ncm ? { ncm: item.ncm } : {}), ...(item.cfop ? { cfop: item.cfop } : {}) },
      kind: brProfileOf(rate?.jurisdictionMetadata)?.kind,
    };
  });
}

/** The taxes of each line, worked out again by the BR engine, and the retentions the invoice shows. */
function documentTaxes(
  invoice: InvoiceRow,
  entity: EntityRow,
  items: InvoiceItemRow[],
  lines: BrFiscalLine[],
  rates: Awaited<ReturnType<typeof loadTaxRates>>,
  counterparty: BrFiscalCounterparty,
) {
  const inputs: DocumentTaxLineInput[] = items.map((item, i) => {
    const rate = item.taxRateId ? rates.get(item.taxRateId) : undefined;
    return {
      lineTotal: lines[i].lineTotal,
      taxRateId: item.taxRateId,
      taxRateName: rate?.name ?? null,
      taxCategoryCode: rate?.taxCategoryCode ?? null,
      rate: num(item.taxRate),
      jurisdictionMetadata: rate?.jurisdictionMetadata ?? null,
      fiscalData: lines[i].fiscal as Record<string, unknown>,
    };
  });
  const result = computeBrDocumentTaxes(inputs, {
    direction: 'sales',
    issueDate: isoDay(invoice.issueDate),
    entitySettings: entity.jurisdictionSettings,
    entityTaxClassification: entity.taxClassification,
    counterparty: {
      country: counterparty.address.country ?? null,
      stateCode: counterparty.address.state ?? null,
      taxId: counterparty.taxId ?? null,
      fiscal: counterparty.fiscal as Record<string, unknown>,
    },
    documentFiscal: invoice.fiscalData,
  });
  const stored = (invoice.taxBreakdown ?? []).filter((row) => row.treatment === 'withheld') as DocumentTaxRow[];
  return {
    lines: result.lines.map((l) => l.rows),
    withheld: invoice.taxBreakdown ? stored : result.documentRows,
  };
}

/** The Focus document kind and its payload inputs for an invoice or credit note. Throws what stops it being issued. */
export async function buildIssueContext(
  db: Database,
  entity: EntityRow,
  invoice: InvoiceRow,
  environment: FocusEnvironment,
  now: Date,
): Promise<IssueContext> {
  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoice.id), isNull(schema.invoiceItems.deletedAt)))
    .orderBy(asc(schema.invoiceItems.sortOrder), asc(schema.invoiceItems.createdAt));
  if (items.length === 0) throw new FiscalDocumentError('The invoice has no lines');

  const rates = await loadTaxRates(db, entity.id, items.map((i) => i.taxRateId));
  const lines = toFiscalLines(items, rates);
  const settings = fiscalSettingsOf(entity);
  const kind = chooseFiscalKind(lines, settings);
  const isCreditNote = invoice.type === 'credit_note';

  let referencedAccessKey: string | null = null;
  if (isCreditNote) {
    if (kind !== 'nfe') {
      throw new FiscalDocumentError('A service credit note has no NFS-e. Cancel the original NFS-e instead');
    }
    if (invoice.creditNoteForInvoiceId) {
      const [original] = await db
        .select({ accessKey: schema.fiscalDocuments.accessKey })
        .from(schema.fiscalDocuments)
        .where(
          and(
            eq(schema.fiscalDocuments.sourceId, invoice.creditNoteForInvoiceId),
            eq(schema.fiscalDocuments.kind, 'nfe'),
            eq(schema.fiscalDocuments.status, 'authorized'),
          ),
        )
        .orderBy(desc(schema.fiscalDocuments.createdAt))
        .limit(1);
      referencedAccessKey = original?.accessKey ?? null;
    }
    if (!referencedAccessKey) {
      throw new FiscalDocumentError('A credit note returns an authorized NF-e: issue the NF-e of the invoice it credits first');
    }
  }

  const counterparty = await loadCounterparty(db, invoice);
  const identifiers = (entity.taxIdentifiers ?? {}) as { vatNumber?: string; registrationNumber?: string };
  return {
    kind,
    args: {
      environment,
      now,
      issuer: {
        cnpj: identifiers.vatNumber ? normalizeCnpj(identifiers.vatNumber) : '',
        regime: brRegimeOf(entity.taxClassification),
        inscricaoEstadual: identifiers.registrationNumber ?? null,
        settings,
      },
      counterparty,
      document: {
        number: invoice.invoiceNumber,
        issueDate: isoDay(invoice.issueDate),
        dueDate: isoDay(invoice.dueDate),
        notes: invoice.notes,
        fiscal: (invoice.fiscalData ?? {}) as BrDocumentFiscalData,
        isCreditNote,
        referencedAccessKey,
        online: Boolean(invoice.commerceOrderId),
      },
      lines,
      taxes: documentTaxes(invoice, entity, items, lines, rates, counterparty),
    },
  };
}

/** The next DPS number of the entity's NFS-e Nacional series (gaps are allowed, repeats are not). */
async function nextDpsNumber(db: Database, entityId: string, environment: FocusEnvironment): Promise<number> {
  const [row] = await db
    .insert(schema.entityNumberSequences)
    .values({ id: generateId('seq'), entityId, sequenceType: `dps_${environment}`, prefix: '', nextValue: 2, padding: 0 })
    .onConflictDoUpdate({
      target: [schema.entityNumberSequences.entityId, schema.entityNumberSequences.sequenceType],
      set: { nextValue: sql`${schema.entityNumberSequences.nextValue} + 1`, updatedAt: new Date() },
    })
    .returning();
  return row.nextValue - 1;
}

// --- What a Focus answer changes on the row ----------------------------------------

function errorMessages(data: FocusRecord): string[] {
  const messages: string[] = [];
  const sefaz = str(data.mensagem_sefaz);
  if (sefaz) messages.push(sefaz);
  if (Array.isArray(data.erros)) {
    for (const item of data.erros) {
      const text = str((item as FocusRecord | null)?.mensagem);
      if (text && !messages.includes(text)) messages.push(text);
    }
  }
  return messages;
}

/** The columns a Focus document answer sets, leaving alone what it does not carry. */
export function documentColumns(row: Pick<FiscalDocumentRow, 'status' | 'authorizedAt' | 'cancelledAt'>, data: FocusRecord, client: Pick<FocusClient, 'absoluteUrl'>) {
  const status = mapFocusStatus(data.status);
  const now = new Date();
  const protocolRecord = (data.protocolo_nota_fiscal ?? null) as FocusRecord | null;
  const messages = errorMessages(data);
  const patch: Partial<typeof schema.fiscalDocuments.$inferInsert> = {
    status,
    statusMessage: status === 'rejected' || status === 'authorized' ? messages.join(' | ') || null : null,
    updatedAt: now,
  };
  const number = str(data.numero);
  if (number) patch.number = number.slice(0, 20);
  const series = str(data.serie) ?? str(data.serie_rps);
  if (series) patch.series = series.slice(0, 5);
  const accessKey = accessKeyOf(data.chave_nfe);
  if (accessKey) patch.accessKey = accessKey;
  const verification = str(data.codigo_verificacao);
  if (verification) patch.verificationCode = verification.slice(0, 60);
  const protocol = str(data.protocolo) ?? str(protocolRecord?.numero_protocolo);
  if (protocol) patch.protocol = protocol.slice(0, 60);
  const xml = client.absoluteUrl(data.caminho_xml_nota_fiscal);
  if (xml) patch.xmlUrl = xml;
  const pdf = client.absoluteUrl(data.caminho_danfe) ?? client.absoluteUrl(data.url_danfse);
  if (pdf) patch.pdfUrl = pdf;
  const publicUrl = str(data.url);
  if (publicUrl) patch.publicUrl = publicUrl;

  if (status === 'authorized' && !row.authorizedAt) {
    const received = Date.parse(str(protocolRecord?.data_recebimento) ?? '');
    patch.authorizedAt = Number.isFinite(received) ? new Date(received) : now;
  }
  if (status === 'cancelled' && !row.cancelledAt) patch.cancelledAt = now;

  const kept = Object.fromEntries(Object.entries(data).filter(([key]) => !ECHOED_KEYS.includes(key)));
  patch.responsePayload = kept;
  return patch;
}

// --- Issue -----------------------------------------------------------------------------

export interface IssueResult {
  document: FiscalDocumentRow;
}

export interface FiscalDocumentFilters {
  sourceType?: string;
  sourceId?: string;
  status?: string;
  kind?: string;
}

/** Documents of an entity, newest first, optionally of one source (an invoice) or status. */
export async function listFiscalDocuments(
  db: Database,
  entityId: string,
  filters: FiscalDocumentFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: FiscalDocumentRow[]; totalCount: number }> {
  const conditions = [eq(schema.fiscalDocuments.entityId, entityId)];
  if (filters.sourceType) conditions.push(eq(schema.fiscalDocuments.sourceType, filters.sourceType));
  if (filters.sourceId) conditions.push(eq(schema.fiscalDocuments.sourceId, filters.sourceId));
  if (filters.status) conditions.push(eq(schema.fiscalDocuments.status, filters.status));
  if (filters.kind) conditions.push(eq(schema.fiscalDocuments.kind, filters.kind));
  const where = and(...conditions);
  const [rows, countRes] = await Promise.all([
    db.select().from(schema.fiscalDocuments).where(where).orderBy(desc(schema.fiscalDocuments.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.fiscalDocuments).where(where),
  ]);
  return { rows, totalCount: Number(countRes[0]?.count ?? 0) };
}

export async function getFiscalDocument(db: Database, entityId: string, id: string): Promise<FiscalDocumentRow> {
  const [row] = await db
    .select()
    .from(schema.fiscalDocuments)
    .where(and(eq(schema.fiscalDocuments.id, id), eq(schema.fiscalDocuments.entityId, entityId)))
    .limit(1);
  if (!row) throw new FiscalDocumentError('Fiscal document not found', 404);
  return row;
}

/** Provider references are alphanumeric with underscores and dashes, up to 60 characters. */
export function providerRefFor(sourceId: string, attempt: number): string {
  return `${sourceId.replace(/[^A-Za-z0-9_-]/g, '')}-${attempt}`.slice(-60);
}

export interface IssueArgs {
  entityId: string;
  invoiceId: string;
  userId?: string | null;
  /** Injected by tests. */
  fetch?: typeof fetch;
  now?: Date;
}

/** The invoice to issue: it has to exist in the entity, not be a pro forma, and be finalized. */
async function loadIssuableInvoice(db: Database, entity: EntityRow, invoiceId: string): Promise<InvoiceRow> {
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.entityId, entity.id), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!invoice) throw new FiscalDocumentError('Invoice not found', 404);
  if (invoice.type === 'proforma') throw new FiscalDocumentError('A pro forma invoice cannot be issued as a fiscal document');
  if (NOT_ISSUABLE_STATUSES.has(invoice.status)) {
    throw new FiscalDocumentError('Finalize the invoice before issuing its fiscal document');
  }
  return invoice;
}

/**
 * The earlier attempts of a source document, once the ones a network failure left
 * behind are settled. Throws when one is authorized or still being authorized.
 */
async function settlePreviousDocuments(
  db: Database,
  env: Env,
  sourceType: 'invoice' | 'credit_note',
  sourceId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<FiscalDocumentRow[]> {
  const earlier = await db
    .select()
    .from(schema.fiscalDocuments)
    .where(and(eq(schema.fiscalDocuments.sourceType, sourceType), eq(schema.fiscalDocuments.sourceId, sourceId)))
    .orderBy(desc(schema.fiscalDocuments.createdAt));
  // A network failure may have left a document with Focus: settle those before sending another.
  for (const stale of earlier.filter((d) => d.status === 'error')) {
    try {
      await refreshFiscalDocument(db, env, stale, { fetch: fetchImpl });
    } catch (err) {
      if (!(err instanceof FiscalProviderError) && !(err instanceof FiscalDocumentError)) throw err;
    }
  }
  const previous = await db
    .select()
    .from(schema.fiscalDocuments)
    .where(and(eq(schema.fiscalDocuments.sourceType, sourceType), eq(schema.fiscalDocuments.sourceId, sourceId)));
  const live = previous.find((d) => d.status === 'authorized' || d.status === 'processing');
  if (live) {
    throw new FiscalDocumentError(
      live.status === 'authorized' ? 'This invoice already has an authorized fiscal document' : 'This invoice has a fiscal document that is still being authorized',
      409,
      { documentId: live.id },
    );
  }
  return previous;
}

async function payloadFor(db: Database, entity: EntityRow, context: IssueContext, environment: FocusEnvironment): Promise<FocusRecord> {
  if (context.kind === 'nfe') return buildNfePayload(context.args);
  if (context.kind === 'nfse') return buildNfsePayload(context.args);
  return buildNfsenPayload({ ...context.args, dpsNumber: await nextDpsNumber(db, entity.id, environment) });
}

/** Write the attempt's row as `processing` before sending it, so an early webhook finds it. */
async function insertProcessingDocument(db: Database, values: typeof schema.fiscalDocuments.$inferInsert): Promise<FiscalDocumentRow> {
  try {
    const [created] = await db.insert(schema.fiscalDocuments).values(values).returning();
    return created;
  } catch (err) {
    // Two requests for the same invoice at once pick the same reference: the unique index lets only one through.
    if (err instanceof Error && /fiscal_documents_provider_ref_idx|duplicate key/.test(`${err.message} ${String(err.cause ?? '')}`)) {
      throw new FiscalDocumentError('This invoice is already being issued', 409);
    }
    throw err;
  }
}

/**
 * Issue the NF-e or NFS-e of a finalized invoice or credit note. Returns the
 * new row (`processing`, or already `authorized` when Focus answers
 * synchronously). A provider rejection is saved on the row and rethrown.
 */
export async function issueFiscalDocument(db: Database, env: Env, args: IssueArgs): Promise<IssueResult> {
  const now = args.now ?? new Date();
  const entity = await requireFiscalEntity(db, args.entityId);
  const invoice = await loadIssuableInvoice(db, entity, args.invoiceId);

  const settings = fiscalSettingsOf(entity);
  const environment = fiscalEnvironmentOf(settings);
  const client = await focusClientFor(entity, env, environment, args.fetch);
  const sourceType = invoice.type === 'credit_note' ? 'credit_note' : 'invoice';

  const previous = await settlePreviousDocuments(db, env, sourceType, invoice.id, args.fetch);

  const context = await buildIssueContext(db, entity, invoice, environment, now);
  const payload = await payloadFor(db, entity, context, environment);

  const id = generateId('fdoc');
  const providerRef = providerRefFor(invoice.id, previous.length + 1);
  const created = await insertProcessingDocument(db, {
    id,
    entityId: entity.id,
    sourceType,
    sourceId: invoice.id,
    kind: context.kind,
    provider: 'focus_nfe',
    providerRef,
    environment,
    status: 'processing',
    requestPayload: payload,
    createdBy: args.userId ?? null,
  });

  try {
    const res = await client.submit(context.kind, providerRef, payload);
    const [saved] = await db
      .update(schema.fiscalDocuments)
      .set(documentColumns(created, res.data, client))
      .where(eq(schema.fiscalDocuments.id, id))
      .returning();
    return { document: saved };
  } catch (err) {
    if (err instanceof FiscalProviderError) {
      await db
        .update(schema.fiscalDocuments)
        .set({
          status: err.isRejection ? 'rejected' : 'error',
          statusMessage: err.detail.slice(0, 2000),
          responsePayload: { codigo: err.codigo ?? null, mensagem: err.message, erros: err.erros },
          updatedAt: new Date(),
        })
        .where(eq(schema.fiscalDocuments.id, id));
    }
    throw err;
  }
}

// --- Refresh ----------------------------------------------------------------------------

export interface RefreshResult {
  document: FiscalDocumentRow;
  /** The status moved (or a number / key arrived). */
  changed: boolean;
  previousStatus: string;
}

/** Ask Focus for the document's state and store it. */
export async function refreshFiscalDocument(
  db: Database,
  env: Env,
  doc: FiscalDocumentRow,
  options: { fetch?: typeof fetch } = {},
): Promise<RefreshResult> {
  const entity = await requireFiscalEntity(db, doc.entityId);
  const client = await focusClientFor(entity, env, doc.environment as FocusEnvironment, options.fetch);
  let res;
  try {
    res = await client.get(doc.kind as FocusDocumentKind, doc.providerRef);
  } catch (err) {
    // Focus does not know the reference: the POST never got there.
    if (err instanceof FiscalProviderError && err.status === 404) {
      if (doc.status === 'error' || doc.status === 'processing') {
        const [saved] = await db
          .update(schema.fiscalDocuments)
          .set({ status: 'error', statusMessage: 'Focus NFe has no record of this document: the request did not arrive. Issue it again.', updatedAt: new Date() })
          .where(eq(schema.fiscalDocuments.id, doc.id))
          .returning();
        return { document: saved, changed: doc.status !== 'error', previousStatus: doc.status };
      }
    }
    throw err;
  }
  // A cancelled document stays cancelled even if a late status says otherwise.
  const patch = documentColumns(doc, res.data, client);
  const [saved] = await db.update(schema.fiscalDocuments).set(patch).where(eq(schema.fiscalDocuments.id, doc.id)).returning();
  const changed = saved.status !== doc.status || saved.number !== doc.number || saved.accessKey !== doc.accessKey;
  return { document: saved, changed, previousStatus: doc.status };
}

// --- Cancel and correction ---------------------------------------------------------------

export async function cancelFiscalDocument(
  db: Database,
  env: Env,
  doc: FiscalDocumentRow,
  reason: string,
  options: { fetch?: typeof fetch } = {},
): Promise<FiscalDocumentRow> {
  if (doc.status !== 'authorized') {
    throw new FiscalDocumentError('Only an authorized fiscal document can be cancelled');
  }
  const entity = await requireFiscalEntity(db, doc.entityId);
  const client = await focusClientFor(entity, env, doc.environment as FocusEnvironment, options.fetch);
  const res = await client.cancel(doc.kind as FocusDocumentKind, doc.providerRef, reason);

  if (mapFocusStatus(res.data.status) !== 'cancelled') {
    const messages = errorMessages(res.data);
    throw new FiscalDocumentError(messages.join(' | ') || 'The cancellation was not accepted', 400, { provider: 'focus_nfe', status: str(res.data.status) });
  }
  const now = new Date();
  const kept = { ...(doc.responsePayload ?? {}), cancellation: res.data };
  const cancellationXml = client.absoluteUrl(res.data.caminho_xml_cancelamento);
  const [saved] = await db
    .update(schema.fiscalDocuments)
    .set({
      status: 'cancelled',
      cancelledAt: now,
      cancelReason: reason,
      statusMessage: str(res.data.mensagem_sefaz) ?? null,
      responsePayload: { ...kept, ...(cancellationXml ? { cancellationXmlUrl: cancellationXml } : {}) },
      updatedAt: now,
    })
    .where(eq(schema.fiscalDocuments.id, doc.id))
    .returning();
  return saved;
}

export interface CorrectionResult {
  document: FiscalDocumentRow;
  correction: { status: string; number: number | null; xmlUrl: string | null; pdfUrl: string | null; message: string | null };
}

/** Carta de correção on an authorized NF-e (it cannot change amounts, parties or dates). */
export async function correctFiscalDocument(
  db: Database,
  env: Env,
  doc: FiscalDocumentRow,
  text: string,
  options: { fetch?: typeof fetch } = {},
): Promise<CorrectionResult> {
  if (doc.kind !== 'nfe') throw new FiscalDocumentError('A carta de correção only exists for the NF-e');
  if (doc.status !== 'authorized') throw new FiscalDocumentError('Only an authorized NF-e can be corrected');
  const entity = await requireFiscalEntity(db, doc.entityId);
  const client = await focusClientFor(entity, env, doc.environment as FocusEnvironment, options.fetch);
  const res = await client.correction(doc.providerRef, text);

  if (mapFocusStatus(res.data.status) !== 'authorized') {
    const messages = errorMessages(res.data);
    throw new FiscalDocumentError(messages.join(' | ') || 'The correction was not accepted', 400, { provider: 'focus_nfe', status: str(res.data.status) });
  }
  const correction = {
    status: 'authorized',
    number: typeof res.data.numero_carta_correcao === 'number' ? res.data.numero_carta_correcao : Number.parseInt(str(res.data.numero_carta_correcao) ?? '', 10) || null,
    xmlUrl: client.absoluteUrl(res.data.caminho_xml_carta_correcao),
    pdfUrl: client.absoluteUrl(res.data.caminho_pdf_carta_correcao),
    message: str(res.data.mensagem_sefaz) ?? null,
  };
  const previous = Array.isArray(doc.responsePayload?.corrections) ? (doc.responsePayload?.corrections as unknown[]) : [];
  const [saved] = await db
    .update(schema.fiscalDocuments)
    .set({
      responsePayload: { ...(doc.responsePayload ?? {}), corrections: [...previous, { ...correction, text, at: new Date().toISOString() }] },
      updatedAt: new Date(),
    })
    .where(eq(schema.fiscalDocuments.id, doc.id))
    .returning();
  return { document: saved, correction };
}

/** The data an entity event carries for a fiscal document: no payloads, no credentials. */
export function fiscalDocumentEventData(doc: FiscalDocumentRow): Record<string, unknown> {
  return {
    id: doc.id,
    entityId: doc.entityId,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId,
    kind: doc.kind,
    environment: doc.environment,
    status: doc.status,
    number: doc.number,
    series: doc.series,
    accessKey: doc.accessKey,
  };
}

