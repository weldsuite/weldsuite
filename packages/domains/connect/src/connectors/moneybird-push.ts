/**
 * WeldBooks → Moneybird push: imported Stripe sales go on to Moneybird.
 *
 * Runs after every Stripe import (sync, webhook, catch-up), from the
 * `moneybird_push` D1 work row while a backlog remains, and on "Send now".
 *
 * - Invoices become external sales invoices (Stripe's number as reference, the
 *   PDF attached). The contact is found by mapping or email, else created.
 * - Per paid payout, one financial statement on the Moneybird account that
 *   stands for the Stripe balance; its lines are then booked: charge → the
 *   invoice's payment, fees → fee ledger, payout → transfer ledger.
 *   Without that account, paid invoices are just marked paid.
 *
 * State lives in `integration_entity_mappings` on the Moneybird connection, so
 * nothing is sent twice:
 *   - invoice rows: `external_entity_id` is `pending:<invoice>` while claimed,
 *     `failed:<invoice>` after a failure (retried after a cooldown or on
 *     "Send now"), else the Moneybird id; `sync_checksum` is open | paid | void.
 *   - statement rows: the same, keyed by the payout's bank transaction.
 *   - pushed mutation rows: one per statement line, `sync_checksum` says how it
 *     still has to be booked (`todo:…`), or that it was (`linked`, `manual`, `failed:…`).
 * A statement is recorded the moment Moneybird created it; booking its lines
 * is a separate, resumable step, so a failure never posts a statement twice.
 */

import { and, asc, count, desc, eq, gte, inArray, isNull, sql, type AnyColumn } from 'drizzle-orm';
import {
  ConnectorApiError,
  MoneybirdClient,
  MONEYBIRD_PUSH_INTERVAL_MS,
  upsertTenantWorkIndex,
  type MoneybirdLedgerAccount,
  type MoneybirdTaxRate,
} from '@weldsuite/connectors';
import type { MoneybirdPushSettings, MoneybirdTaxRateOverrides } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createConnectorClient } from './clients';
import {
  decryptCredentials,
  finishSyncRun,
  keyringFromEnv,
  listConnectionsByProvider,
  startSyncRun,
  type ConnectorConnectionRow,
} from './connections';
import {
  buildExternalSalesInvoicePayload,
  buildMoneybirdContactPayload,
  matchCreatedMutations,
  planPayoutStatement,
  type PayoutLine,
  type PlannedMutation,
  type PushContactInput,
} from './moneybird-push-plan';
import type { ConnectorSyncEnv } from './sync';

export const MONEYBIRD_PUSH_SYNC_NAME = 'moneybird-push';
export const MB_INVOICE_TYPE = 'moneybird_external_sales_invoice';
export const MB_STATEMENT_TYPE = 'moneybird_financial_statement';
export const MB_PUSHED_MUTATION_TYPE = 'moneybird_pushed_mutation';
const MB_CONTACT_TYPE = 'moneybird_contact';
const STRIPE_INVOICE_TYPE = 'stripe_invoice';
const STRIPE_LINE_TYPE = 'stripe_balance_transaction';

/** Moneybird allows ~150 requests per 5 minutes; leave room for the inbound sync. */
const REQUEST_BUDGET = 100;
const MAX_INVOICES_PER_PASS = 20;
const MAX_PAYOUTS_PER_PASS = 3;
const MAX_LINKS_PER_PASS = 60;
const FAILED_RETRY_AFTER_MS = 6 * 60 * 60_000;
const STALE_CLAIM_MS = 30 * 60_000;
const MAX_ERROR_SAMPLES = 10;

const PUSHABLE_STATUSES = ['sent', 'paid', 'partial', 'overdue', 'uncollectible'];

export type MoneybirdPushEnv = ConnectorSyncEnv;

export const DEFAULT_TAX_OVERRIDES: MoneybirdTaxRateOverrides = {
  reverseCharge: null,
  outsideEu: null,
  exempt: null,
  noTax: null,
};

export interface MoneybirdPushResult {
  invoicesPushed: number;
  statementsPushed: number;
  linesBooked: number;
  failed: number;
  /** Work is left (budget, rate limit, or more than one pass worth). */
  remaining: boolean;
  skipped?: string;
}

class BudgetExhausted extends Error {
  constructor() {
    super('Moneybird request budget for this pass used up');
  }
}

interface PassState {
  connection: ConnectorConnectionRow;
  settings: MoneybirdPushSettings;
  client: MoneybirdClient;
  sources: string[];
  budget: number;
  remaining: boolean;
  counts: { invoices: number; statements: number; lines: number; failed: number };
  errors: Array<{ externalId: string; message: string }>;
  taxRates: MoneybirdTaxRate[] | null;
  financialAccountCurrency: string | null | undefined;
}

function spend(state: PassState, requests = 1): void {
  if (state.budget < requests) throw new BudgetExhausted();
  state.budget -= requests;
}

function recordError(state: PassState, externalId: string, err: unknown): void {
  state.counts.failed += 1;
  if (state.errors.length >= MAX_ERROR_SAMPLES) return;
  const message = err instanceof Error ? err.message : String(err);
  state.errors.push({ externalId, message: message.slice(0, 300) });
}

/** Rate limits and an exhausted budget end the pass; the rest of the work waits for the next one. */
function endsPass(err: unknown): boolean {
  return err instanceof BudgetExhausted || (err instanceof ConnectorApiError && err.kind === 'rate_limit');
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof ConnectorApiError && err.kind === 'auth';
}

function textId(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function ymd(date: Date | string | null | undefined): string {
  const value = date instanceof Date ? date : new Date(date ?? Date.now());
  return value.toISOString().slice(0, 10);
}

export function pushSettingsOf(connection: Pick<ConnectorConnectionRow, 'settings'>): MoneybirdPushSettings | null {
  const push = connection.settings?.moneybirdPush;
  if (!push) return null;
  return {
    ...push,
    sourceConnectionIds: push.sourceConnectionIds ?? [],
    taxRateOverrides: { ...DEFAULT_TAX_OVERRIDES, ...push.taxRateOverrides },
  };
}

async function moneybirdClientFor(env: MoneybirdPushEnv, connection: ConnectorConnectionRow): Promise<MoneybirdClient> {
  const credentials = await decryptCredentials(connection.credentials ?? undefined, keyringFromEnv(env));
  const client = createConnectorClient('moneybird', credentials, connection.externalAccountId);
  if (!(client instanceof MoneybirdClient)) throw new Error('Not a Moneybird connection');
  return client;
}

async function sourceStripeConnectionIds(db: Database, settings: MoneybirdPushSettings): Promise<string[]> {
  const stripe = await listConnectionsByProvider(db, 'stripe');
  const ids = stripe.map((row) => row.id);
  if (settings.sourceConnectionIds.length === 0) return ids;
  return ids.filter((id) => settings.sourceConnectionIds.includes(id));
}

// ------------------------------------------------------------------ claims

const m = schema.integrationEntityMappings;

/** SQL: no push row keeps `internalId` out of this pass (done, in flight, or cooling down after a failure). */
function noBlockingRow(connectionId: string, type: string, internalId: AnyColumn, force: boolean) {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_CLAIM_MS).toISOString();
  const retryCutoff = new Date(force ? now : now - FAILED_RETRY_AFTER_MS).toISOString();
  return sql`not exists (
    select 1 from integration_entity_mappings p
    where p.connection_id = ${connectionId}
      and p.external_entity_type = ${type}
      and p.internal_entity_id = ${internalId}
      and (
        (p.external_entity_id not like 'pending:%' and p.external_entity_id not like 'failed:%')
        or (p.external_entity_id like 'pending:%' and p.updated_at > ${staleCutoff}::timestamp)
        or (p.external_entity_id like 'failed:%' and p.updated_at > ${retryCutoff}::timestamp)
      )
  )`;
}

/** Claim an internal row for this pass; null when it is done, in flight, or cooling down after a failure. */
async function claim(
  db: Database,
  args: { connectionId: string; type: string; internalType: string; internalId: string; force: boolean },
): Promise<string | null> {
  const rows = await db
    .select({ id: m.id, externalEntityId: m.externalEntityId, updatedAt: m.updatedAt })
    .from(m)
    .where(and(eq(m.connectionId, args.connectionId), eq(m.externalEntityType, args.type), eq(m.internalEntityId, args.internalId)));
  const now = Date.now();
  const pendingId = `pending:${args.internalId}`;
  let reusable: (typeof rows)[number] | null = null;
  for (const row of rows) {
    const age = now - new Date(row.updatedAt).getTime();
    if (row.externalEntityId.startsWith('pending:')) {
      if (age < STALE_CLAIM_MS) return null;
      reusable = row;
    } else if (row.externalEntityId.startsWith('failed:')) {
      if (!args.force && age < FAILED_RETRY_AFTER_MS) return null;
      reusable = row;
    } else {
      return null;
    }
  }
  if (reusable) {
    // Compare-and-set on updated_at: only one concurrent pass wins the stale row.
    const updated = await db
      .update(m)
      .set({ externalEntityId: pendingId, updatedAt: new Date() })
      .where(and(eq(m.id, reusable.id), eq(m.updatedAt, reusable.updatedAt)))
      .returning({ id: m.id });
    return updated[0]?.id ?? null;
  }
  // Timestamps from JS (ms), not the database's now() (µs), so the
  // compare-and-set above can match them when the claim is reused.
  const stamp = new Date();
  const inserted = await db
    .insert(m)
    .values({
      id: generateId('iem'),
      createdAt: stamp,
      updatedAt: stamp,
      connectionId: args.connectionId,
      externalEntityType: args.type,
      externalEntityId: pendingId,
      internalEntityType: args.internalType,
      internalEntityId: args.internalId,
    })
    .onConflictDoNothing()
    .returning({ id: m.id });
  return inserted[0]?.id ?? null;
}

async function completeClaim(db: Database, rowId: string, externalId: string, checksum: string): Promise<void> {
  const now = new Date();
  await db
    .update(m)
    .set({ externalEntityId: externalId, syncChecksum: checksum, lastSyncedAt: now, updatedAt: now })
    .where(eq(m.id, rowId));
}

async function failClaim(db: Database, rowId: string, internalId: string): Promise<void> {
  await db.update(m).set({ externalEntityId: `failed:${internalId}`, updatedAt: new Date() }).where(eq(m.id, rowId));
}

async function releaseClaim(db: Database, rowId: string): Promise<void> {
  await db.delete(m).where(eq(m.id, rowId));
}

// ------------------------------------------------------------------ contacts

async function loadContact(db: Database, partyId: string): Promise<PushContactInput | null> {
  const [party] = await db
    .select({
      kind: schema.parties.kind,
      displayName: schema.parties.displayName,
      billingAddress: schema.parties.billingAddress,
      companyId: schema.parties.companyId,
      personId: schema.parties.personId,
    })
    .from(schema.parties)
    .where(eq(schema.parties.id, partyId))
    .limit(1);
  if (!party) return null;

  if (party.kind === 'company' && party.companyId) {
    const [company] = await db
      .select({
        name: schema.companies.name,
        email: schema.companies.email,
        phone: schema.companies.phone,
        vatNumber: schema.companies.vatNumber,
        primaryAddress: schema.companies.primaryAddress,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, party.companyId))
      .limit(1);
    return {
      kind: 'company',
      displayName: company?.name ?? party.displayName ?? 'Customer',
      firstName: null,
      lastName: null,
      email: company?.email ?? null,
      phone: company?.phone ?? null,
      vatNumber: company?.vatNumber ?? null,
      address: party.billingAddress ?? (company?.primaryAddress as PushContactInput['address']) ?? null,
    };
  }

  const [person] = party.personId
    ? await db
        .select({
          firstName: schema.people.firstName,
          lastName: schema.people.lastName,
          email: schema.people.email,
          phone: schema.people.directPhone,
          primaryAddress: schema.people.primaryAddress,
        })
        .from(schema.people)
        .where(eq(schema.people.id, party.personId))
        .limit(1)
    : [];
  return {
    kind: 'person',
    displayName: party.displayName ?? 'Customer',
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
    email: person?.email ?? null,
    phone: person?.phone ?? null,
    vatNumber: null,
    address: party.billingAddress ?? (person?.primaryAddress as PushContactInput['address']) ?? null,
  };
}

async function resolveMoneybirdContact(db: Database, state: PassState, partyId: string): Promise<string> {
  const [mapped] = await db
    .select({ externalEntityId: m.externalEntityId })
    .from(m)
    .where(
      and(
        eq(m.connectionId, state.connection.id),
        eq(m.externalEntityType, MB_CONTACT_TYPE),
        eq(m.internalEntityType, 'party'),
        eq(m.internalEntityId, partyId),
      ),
    )
    .limit(1);
  if (mapped) return mapped.externalEntityId;

  const contact = await loadContact(db, partyId);
  if (!contact) throw new Error('The invoice contact no longer exists');

  let contactId: string | null = null;
  if (contact.email) {
    spend(state);
    const found = await state.client.searchContacts(contact.email);
    const email = contact.email.toLowerCase();
    const hit = found.find((row) => typeof row.email === 'string' && row.email.toLowerCase() === email);
    contactId = hit ? textId(hit.id) : null;
  }
  if (!contactId) {
    spend(state);
    const created = await state.client.createContact(buildMoneybirdContactPayload(contact));
    contactId = textId(created.id);
  }
  if (!contactId) throw new Error('Moneybird did not return a contact id');

  // Same mapping type as the inbound contact sync: when it imports this contact, it updates this party.
  await db
    .insert(m)
    .values({
      id: generateId('iem'),
      connectionId: state.connection.id,
      externalEntityType: MB_CONTACT_TYPE,
      externalEntityId: contactId,
      internalEntityType: 'party',
      internalEntityId: partyId,
      lastSyncedAt: new Date(),
    })
    .onConflictDoNothing();
  return contactId;
}

// ------------------------------------------------------------------ invoices

async function taxRatesFor(state: PassState): Promise<MoneybirdTaxRate[]> {
  if (state.taxRates) return state.taxRates;
  spend(state);
  state.taxRates = await state.client.listTaxRates();
  return state.taxRates;
}

function invoiceStartDate(settings: MoneybirdPushSettings): Date | null {
  if (!settings.startDate) return null;
  const parsed = new Date(`${settings.startDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pendingInvoiceConditions(state: Pick<PassState, 'connection' | 'settings' | 'sources'>, force: boolean) {
  // Callers check `sources` is non-empty; inArray with [] is invalid SQL.
  const start = invoiceStartDate(state.settings);
  return and(
    inArray(m.connectionId, state.sources),
    eq(m.externalEntityType, STRIPE_INVOICE_TYPE),
    eq(m.internalEntityType, 'invoice'),
    isNull(schema.invoices.deletedAt),
    inArray(schema.invoices.status, PUSHABLE_STATUSES),
    start ? gte(schema.invoices.issueDate, start) : undefined,
    noBlockingRow(state.connection.id, MB_INVOICE_TYPE, schema.invoices.id, force),
  );
}

type PendingScope = Pick<PassState, 'connection' | 'settings' | 'sources'>;

async function pendingInvoiceIds(db: Database, state: PendingScope, force: boolean, limit: number): Promise<string[]> {
  if (state.sources.length === 0) return [];
  const rows = await db
    .select({ id: schema.invoices.id })
    .from(m)
    .innerJoin(schema.invoices, eq(schema.invoices.id, m.internalEntityId))
    .where(pendingInvoiceConditions(state, force))
    .orderBy(asc(schema.invoices.issueDate), asc(schema.invoices.id))
    .limit(limit);
  return [...new Set(rows.map((row) => row.id))];
}

async function attachPdf(env: MoneybirdPushEnv, state: PassState, moneybirdId: string, keys: string[] | null): Promise<void> {
  const key = keys?.[0];
  if (!key || !env.STORAGE) return;
  const object = await env.STORAGE.get(key);
  if (!object) return;
  spend(state);
  await state.client.uploadExternalSalesInvoiceAttachment(moneybirdId, {
    bytes: await object.arrayBuffer(),
    filename: key.split('/').at(-1) ?? 'invoice.pdf',
    contentType: object.httpMetadata?.contentType ?? 'application/pdf',
  });
}

/** Moneybird recomputes VAT from the lines; settle a cent of difference so the invoice closes. */
async function settleRounding(state: PassState, moneybirdId: string, created: Record<string, unknown>, stripeTotal: string, date: string): Promise<void> {
  const moneybirdTotal = Number(created.total_price_incl_tax);
  const diff = Math.round((moneybirdTotal - Number(stripeTotal)) * 100) / 100;
  if (!Number.isFinite(diff) || diff <= 0 || diff > 0.05) return;
  spend(state);
  await state.client.createExternalSalesInvoicePayment(moneybirdId, {
    payment_date: date,
    price: diff.toFixed(2),
    manual_payment_action: 'rounding_error',
  });
}

async function markPaidWithoutStatement(state: PassState, moneybirdId: string, invoice: { total: string | null; paidAt: Date | null; issueDate: Date }): Promise<void> {
  spend(state);
  await state.client.createExternalSalesInvoicePayment(moneybirdId, {
    payment_date: ymd(invoice.paidAt ?? invoice.issueDate),
    price: Number(invoice.total ?? 0).toFixed(2),
  });
}

async function pushInvoice(db: Database, env: MoneybirdPushEnv, state: PassState, invoiceId: string, force: boolean): Promise<void> {
  const claimId = await claim(db, {
    connectionId: state.connection.id,
    type: MB_INVOICE_TYPE,
    internalType: 'invoice',
    internalId: invoiceId,
    force,
  });
  if (!claimId) return;

  const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
  const label = invoice?.invoiceNumber ?? invoiceId;
  let moneybirdId: string | null = null;
  let created: Record<string, unknown> = {};
  try {
    if (!invoice) throw new Error('Invoice not found');
    if (!state.settings.revenueLedgerAccountId) throw new Error('Pick a revenue ledger account on the Moneybird connection');
    const items = await db
      .select()
      .from(schema.invoiceItems)
      .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)))
      .orderBy(asc(schema.invoiceItems.sortOrder));
    const contactId = await resolveMoneybirdContact(db, state, invoice.counterpartyId ?? invoice.contactId);
    const built = buildExternalSalesInvoicePayload({
      invoice: {
        invoiceNumber: label,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency ?? 'EUR',
        paymentLink: invoice.paymentLink,
        taxBreakdown: invoice.taxBreakdown ?? [],
        lines: items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          taxRate: item.taxRate,
          period: item.period ?? null,
        })),
      },
      contactId,
      revenueLedgerAccountId: state.settings.revenueLedgerAccountId,
      taxRates: await taxRatesFor(state),
      overrides: state.settings.taxRateOverrides,
    });
    if ('error' in built) throw new Error(built.error);

    spend(state);
    created = await state.client.createExternalSalesInvoice(built.payload);
    moneybirdId = textId(created.id);
    if (!moneybirdId) throw new Error('Moneybird did not return an invoice id');
    await completeClaim(db, claimId, moneybirdId, 'open');
    state.counts.invoices += 1;
  } catch (err) {
    if (endsPass(err)) {
      await releaseClaim(db, claimId);
      throw err;
    }
    await failClaim(db, claimId, invoiceId);
    recordError(state, label, err);
    if (isAuthFailure(err)) throw err;
    return;
  }

  // The invoice exists in Moneybird now; what follows may fail without undoing it.
  try {
    await attachPdf(env, state, moneybirdId, invoice.attachmentKeys ?? null);
    await settleRounding(state, moneybirdId, created, invoice.total ?? '0', ymd(invoice.issueDate));
    if (invoice.status === 'paid' && !state.settings.financialAccountId) {
      await markPaidWithoutStatement(state, moneybirdId, invoice);
      await completeClaim(db, claimId, moneybirdId, 'paid');
    }
  } catch (err) {
    if (endsPass(err)) throw err;
    recordError(state, label, err);
  }
}

/**
 * Pushed invoices whose state moved on in WeldBooks: voided → removed from
 * Moneybird; paid → marked paid when there is no Stripe account to book the
 * payment through (with one, the payout statement does it).
 */
function followUpRows(db: Database, state: PendingScope, limit: number) {
  return db
    .select({ rowId: m.id, moneybirdId: m.externalEntityId, invoice: schema.invoices })
    .from(m)
    .innerJoin(schema.invoices, eq(schema.invoices.id, m.internalEntityId))
    .where(
      and(
        eq(m.connectionId, state.connection.id),
        eq(m.externalEntityType, MB_INVOICE_TYPE),
        eq(m.syncChecksum, 'open'),
        sql`${m.externalEntityId} not like 'pending:%' and ${m.externalEntityId} not like 'failed:%'`,
        state.settings.financialAccountId
          ? eq(schema.invoices.status, 'cancelled')
          : inArray(schema.invoices.status, ['cancelled', 'paid']),
      ),
    )
    .limit(limit);
}

async function followUpInvoices(db: Database, state: PassState): Promise<void> {
  const rows = await followUpRows(db, state, MAX_INVOICES_PER_PASS);
  for (const row of rows) {
    try {
      if (row.invoice.status === 'cancelled') {
        spend(state);
        await state.client.deleteExternalSalesInvoice(row.moneybirdId);
        await completeClaim(db, row.rowId, row.moneybirdId, 'void');
      } else {
        await markPaidWithoutStatement(state, row.moneybirdId, row.invoice);
        await completeClaim(db, row.rowId, row.moneybirdId, 'paid');
      }
      state.counts.lines += 1;
    } catch (err) {
      if (endsPass(err)) throw err;
      recordError(state, row.invoice.invoiceNumber ?? row.invoice.id, err);
      // Don't retry a refused delete on every pass.
      if (row.invoice.status === 'cancelled') await completeClaim(db, row.rowId, row.moneybirdId, 'void_failed');
    }
  }
}

// ------------------------------------------------------------------ payouts

function rawOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function rawText(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value ? value : null;
}

async function pendingPayoutIds(db: Database, state: PendingScope, force: boolean, limit: number): Promise<string[]> {
  if (state.sources.length === 0 || !state.settings.financialAccountId) return [];
  const start = invoiceStartDate(state.settings);
  const bt = schema.bankTransactions;
  const rows = await db
    .select({ id: bt.id })
    .from(m)
    .innerJoin(bt, eq(bt.id, m.internalEntityId))
    .where(
      and(
        inArray(m.connectionId, state.sources),
        eq(m.externalEntityType, STRIPE_LINE_TYPE),
        isNull(bt.deletedAt),
        sql`${bt.rawData}->>'stripeLine' = 'payout'`,
        start ? gte(bt.date, start) : undefined,
        noBlockingRow(state.connection.id, MB_STATEMENT_TYPE, bt.id, force),
      ),
    )
    .orderBy(asc(bt.date), asc(bt.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Moneybird invoice + WeldBooks number for the Stripe invoice a charge paid. */
async function pushedInvoiceFor(
  db: Database,
  state: PassState,
  sourceConnectionId: string,
  stripeInvoiceId: string,
): Promise<{ moneybirdId: string | null; invoiceNumber: string | null; waiting: boolean }> {
  const [stripeMapping] = await db
    .select({ invoiceId: m.internalEntityId })
    .from(m)
    .where(and(eq(m.connectionId, sourceConnectionId), eq(m.externalEntityType, STRIPE_INVOICE_TYPE), eq(m.externalEntityId, stripeInvoiceId)))
    .limit(1);
  if (!stripeMapping) return { moneybirdId: null, invoiceNumber: null, waiting: false };

  const [invoice] = await db
    .select({ invoiceNumber: schema.invoices.invoiceNumber, status: schema.invoices.status, issueDate: schema.invoices.issueDate })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, stripeMapping.invoiceId))
    .limit(1);
  const [pushed] = await db
    .select({ externalEntityId: m.externalEntityId })
    .from(m)
    .where(and(eq(m.connectionId, state.connection.id), eq(m.externalEntityType, MB_INVOICE_TYPE), eq(m.internalEntityId, stripeMapping.invoiceId)))
    .limit(1);
  const done = pushed && !pushed.externalEntityId.startsWith('pending:') && !pushed.externalEntityId.startsWith('failed:');
  const start = invoiceStartDate(state.settings);
  const inScope = invoice && PUSHABLE_STATUSES.includes(invoice.status) && (!start || invoice.issueDate >= start);
  return {
    moneybirdId: done ? pushed.externalEntityId : null,
    invoiceNumber: invoice?.invoiceNumber ?? null,
    // Not sent yet (and not failed): hold the statement so the payment can be linked.
    waiting: Boolean(inScope && !done && !pushed?.externalEntityId.startsWith('failed:')),
  };
}

async function loadPayoutLines(
  db: Database,
  state: PassState,
  payoutTxnId: string,
): Promise<{ payoutId: string; currency: string; lines: PayoutLine[]; waiting: boolean } | null> {
  const bt = schema.bankTransactions;
  const [payout] = await db
    .select({ rawData: bt.rawData, connectionId: m.connectionId })
    .from(bt)
    .innerJoin(m, and(eq(m.internalEntityId, bt.id), eq(m.externalEntityType, STRIPE_LINE_TYPE)))
    .where(eq(bt.id, payoutTxnId))
    .limit(1);
  const payoutId = payout ? rawText(rawOf(payout.rawData), 'payoutId') : null;
  if (!payout || !payoutId) return null;

  const rows = await db
    .select({ txn: bt })
    .from(m)
    .innerJoin(bt, eq(bt.id, m.internalEntityId))
    .where(
      and(
        eq(m.connectionId, payout.connectionId),
        eq(m.externalEntityType, STRIPE_LINE_TYPE),
        isNull(bt.deletedAt),
        sql`${bt.rawData}->>'payoutId' = ${payoutId}`,
      ),
    )
    .orderBy(asc(bt.date), asc(bt.id));

  let waiting = false;
  const lines: PayoutLine[] = [];
  for (const { txn } of rows) {
    const raw = rawOf(txn.rawData);
    const stripeInvoiceId = rawText(raw, 'invoiceId');
    const pushed = stripeInvoiceId
      ? await pushedInvoiceFor(db, state, payout.connectionId, stripeInvoiceId)
      : { moneybirdId: null, invoiceNumber: null, waiting: false };
    waiting ||= pushed.waiting;
    const line = rawText(raw, 'stripeLine');
    lines.push({
      bankTransactionId: txn.id,
      stripeLine: line === 'fee' || line === 'payout' ? line : 'gross',
      type: rawText(raw, 'type') ?? 'adjustment',
      amount: txn.amount,
      date: txn.date,
      description: txn.description,
      balanceTransactionId: rawText(raw, 'balanceTransactionId'),
      moneybirdInvoiceId: pushed.moneybirdId,
      invoiceNumber: pushed.invoiceNumber,
      counterpartyName: txn.counterpartyName,
    });
  }
  return { payoutId, currency: rawText(rawOf(payout.rawData), 'currency') ?? 'EUR', lines, waiting };
}

async function financialAccountCurrency(state: PassState): Promise<string | null> {
  if (state.financialAccountCurrency !== undefined) return state.financialAccountCurrency;
  spend(state);
  const accounts = await state.client.listFinancialAccounts();
  const account = accounts.items.find((row) => textId(row.id) === state.settings.financialAccountId);
  state.financialAccountCurrency = typeof account?.currency === 'string' ? account.currency.toUpperCase() : null;
  return state.financialAccountCurrency;
}

function bookingChecksum(booking: ReturnType<typeof planPayoutStatement>[number]['booking'], amount: string): string {
  if (booking.kind === 'invoice') return `todo:invoice:${booking.moneybirdInvoiceId}:${amount}`;
  if (booking.kind === 'manual') return 'manual';
  return `todo:${booking.kind}:${amount}`;
}

/** One row per created statement line, saying how it still has to be booked. */
async function recordStatementLines(
  db: Database,
  state: PassState,
  payoutId: string,
  planned: PlannedMutation[],
  statement: Record<string, unknown>,
): Promise<void> {
  const created = Array.isArray(statement.financial_mutations)
    ? (statement.financial_mutations as Array<Record<string, unknown>>)
    : [];
  const ids = matchCreatedMutations(planned, created);
  const now = new Date();
  const rows = planned.flatMap((line) => {
    const mutationId = ids.get(line.token);
    if (!mutationId) return [];
    return [{
      id: generateId('iem'),
      createdAt: now,
      updatedAt: now,
      connectionId: state.connection.id,
      externalEntityType: MB_PUSHED_MUTATION_TYPE,
      externalEntityId: mutationId,
      internalEntityType: 'bank_transaction',
      internalEntityId: line.bankTransactionId,
      syncChecksum: bookingChecksum(line.booking, line.amount),
      lastSyncedAt: now,
    }];
  });
  if (rows.length > 0) await db.insert(m).values(rows).onConflictDoNothing();
  if (rows.length < planned.length) {
    recordError(state, payoutId, new Error('Some statement lines could not be matched; book them in Moneybird'));
  }
}

async function pushPayout(db: Database, state: PassState, payoutTxnId: string, force: boolean): Promise<void> {
  const claimId = await claim(db, {
    connectionId: state.connection.id,
    type: MB_STATEMENT_TYPE,
    internalType: 'bank_transaction',
    internalId: payoutTxnId,
    force,
  });
  if (!claimId) return;

  let label = payoutTxnId;
  try {
    const loaded = await loadPayoutLines(db, state, payoutTxnId);
    if (!loaded) throw new Error('Payout lines not found');
    label = loaded.payoutId;
    if (loaded.waiting) {
      // An invoice it paid is still on its way to Moneybird; try again next pass.
      await releaseClaim(db, claimId);
      state.remaining = true;
      return;
    }
    const accountCurrency = await financialAccountCurrency(state);
    if (accountCurrency && accountCurrency !== loaded.currency.toUpperCase()) {
      throw new Error(`Stripe payout is in ${loaded.currency}, the Moneybird account in ${accountCurrency}`);
    }
    const planned = planPayoutStatement(loaded.payoutId, loaded.lines);
    if (planned.length === 0) throw new Error('Payout has no lines');

    spend(state);
    const statement = await state.client.createFinancialStatement({
      financialAccountId: state.settings.financialAccountId!,
      reference: `Stripe ${loaded.payoutId}`,
      officialDate: planned.at(-1)?.date,
      mutations: planned.map((line) => ({ date: line.date, message: line.message, amount: line.amount })),
    });
    const statementId = textId(statement.id);
    // Recorded before anything else can fail: the statement must never be posted twice.
    await completeClaim(db, claimId, statementId || 'statement:' + loaded.payoutId, 'posted');
    state.counts.statements += 1;
    await recordStatementLines(db, state, loaded.payoutId, planned, statement);
  } catch (err) {
    if (endsPass(err)) {
      await releaseClaim(db, claimId).catch(() => undefined);
      throw err;
    }
    // Only reached before the statement was created (afterwards the claim is complete).
    const [row] = await db.select({ externalEntityId: m.externalEntityId }).from(m).where(eq(m.id, claimId)).limit(1);
    if (row?.externalEntityId.startsWith('pending:')) await failClaim(db, claimId, payoutTxnId);
    recordError(state, label, err);
    if (isAuthFailure(err)) throw err;
  }
}

/**
 * Book one statement line from its `todo:<kind>:…` checksum: the charge as the
 * invoice's payment, fees and payout on their ledgers. `manual` when there is
 * no ledger to book on.
 */
async function bookStatementLine(
  db: Database,
  state: PassState,
  row: { mutationId: string; checksum: string | null; bankTransactionId: string },
): Promise<'linked' | 'manual'> {
  const [, kind, ...rest] = (row.checksum ?? '').split(':');
  if (kind === 'invoice') {
    const [moneybirdInvoiceId = '', amount] = rest;
    const [txn] = await db
      .select({ date: schema.bankTransactions.date })
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.id, row.bankTransactionId))
      .limit(1);
    spend(state);
    await state.client.createExternalSalesInvoicePayment(moneybirdInvoiceId, {
      payment_date: ymd(txn?.date),
      price: amount,
      price_base: amount,
      financial_account_id: state.settings.financialAccountId,
      financial_mutation_id: row.mutationId,
    });
    await db
      .update(m)
      .set({ syncChecksum: 'paid', updatedAt: new Date() })
      .where(and(eq(m.connectionId, state.connection.id), eq(m.externalEntityType, MB_INVOICE_TYPE), eq(m.externalEntityId, moneybirdInvoiceId)));
    return 'linked';
  }
  const ledger = kind === 'fee' ? state.settings.feeLedgerAccountId : state.settings.payoutLedgerAccountId;
  if (!ledger) return 'manual';
  spend(state);
  await state.client.linkFinancialMutation(row.mutationId, {
    bookingType: 'LedgerAccount',
    bookingId: ledger,
    // Positive books in the mutation's own direction (Moneybird).
    priceBase: Math.abs(Number(rest[0] ?? 0)).toFixed(2),
    description: kind === 'fee' ? 'Stripe fees' : 'Stripe payout',
  });
  return 'linked';
}

/** Book statement lines posted earlier: payments onto invoices, fees and payouts onto their ledgers. */
async function bookStatementLines(db: Database, state: PassState): Promise<void> {
  const rows = await db
    .select({ rowId: m.id, mutationId: m.externalEntityId, checksum: m.syncChecksum, bankTransactionId: m.internalEntityId })
    .from(m)
    .where(and(eq(m.connectionId, state.connection.id), eq(m.externalEntityType, MB_PUSHED_MUTATION_TYPE), sql`${m.syncChecksum} like 'todo:%'`))
    .orderBy(asc(m.createdAt))
    .limit(MAX_LINKS_PER_PASS);

  for (const row of rows) {
    const [, kind] = (row.checksum ?? '').split(':');
    try {
      const outcome = await bookStatementLine(db, state, row);
      await db.update(m).set({ syncChecksum: outcome, updatedAt: new Date() }).where(eq(m.id, row.rowId));
      if (outcome === 'linked') state.counts.lines += 1;
    } catch (err) {
      if (endsPass(err)) throw err;
      await db.update(m).set({ syncChecksum: `failed:${kind ?? 'line'}`, updatedAt: new Date() }).where(eq(m.id, row.rowId));
      recordError(state, row.mutationId, err);
      if (isAuthFailure(err)) throw err;
    }
  }
  if (rows.length === MAX_LINKS_PER_PASS) state.remaining = true;
}

// ------------------------------------------------------------------ passes

/**
 * Anything this pass could do. Open invoices that only wait for their payout
 * don't count: otherwise the backlog would re-schedule itself forever.
 */
async function hasWork(db: Database, state: PendingScope, force: boolean): Promise<boolean> {
  if ((await pendingInvoiceIds(db, state, force, 1)).length > 0) return true;
  if ((await pendingPayoutIds(db, state, force, 1)).length > 0) return true;
  if ((await followUpRows(db, state, 1)).length > 0) return true;
  const [todo] = await db
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.connectionId, state.connection.id),
        eq(m.externalEntityType, MB_PUSHED_MUTATION_TYPE),
        sql`${m.syncChecksum} like 'todo:%'`,
      ),
    )
    .limit(1);
  return Boolean(todo);
}

/**
 * One push pass for one Moneybird connection. `force` retries failed rows
 * right away (Send now) instead of after the cooldown.
 */
export async function pushToMoneybird(args: {
  db: Database;
  env: MoneybirdPushEnv;
  connection: ConnectorConnectionRow;
  trigger: 'manual' | 'schedule' | 'webhook';
  force?: boolean;
}): Promise<MoneybirdPushResult> {
  const empty = { invoicesPushed: 0, statementsPushed: 0, linesBooked: 0, failed: 0, remaining: false };
  const settings = pushSettingsOf(args.connection);
  if (!settings?.enabled) return { ...empty, skipped: 'Sending to Moneybird is off' };
  if (args.connection.status === 'paused' || args.connection.status === 'auth_error' || args.connection.deletedAt) {
    return { ...empty, skipped: `Moneybird connection is ${args.connection.status}` };
  }
  const force = args.force ?? false;
  const state: PassState = {
    connection: args.connection,
    settings,
    client: await moneybirdClientFor(args.env, args.connection),
    sources: await sourceStripeConnectionIds(args.db, settings),
    budget: REQUEST_BUDGET,
    remaining: false,
    counts: { invoices: 0, statements: 0, lines: 0, failed: 0 },
    errors: [],
    taxRates: null,
    financialAccountCurrency: undefined,
  };
  if (!(await hasWork(args.db, state, force))) return empty;

  const runId = await startSyncRun({
    db: args.db,
    connectionId: args.connection.id,
    syncName: MONEYBIRD_PUSH_SYNC_NAME,
    model: 'MoneybirdPush',
    trigger: args.trigger,
    syncType: 'PUSH',
  });

  let authError: unknown = null;
  try {
    for (const invoiceId of await pendingInvoiceIds(args.db, state, force, MAX_INVOICES_PER_PASS)) {
      await pushInvoice(args.db, args.env, state, invoiceId, force);
    }
    await followUpInvoices(args.db, state);
    // Statements after invoices, so this pass's payments can be linked.
    for (const payoutTxnId of await pendingPayoutIds(args.db, state, force, MAX_PAYOUTS_PER_PASS)) {
      await pushPayout(args.db, state, payoutTxnId, force);
    }
    await bookStatementLines(args.db, state);
    if (!state.remaining) state.remaining = await hasWork(args.db, state, false);
  } catch (err) {
    if (endsPass(err)) state.remaining = true;
    else if (isAuthFailure(err)) authError = err;
    else recordError(state, '-', err);
  }

  const applied = {
    created: state.counts.invoices + state.counts.statements,
    modified: state.counts.lines,
    skipped: 0,
    deleted: 0,
    failed: state.counts.failed,
  };
  let status: 'success' | 'partial' | 'error' = state.counts.failed > 0 ? 'partial' : 'success';
  if (authError) status = 'error';
  await finishSyncRun({
    db: args.db,
    runId,
    connectionId: args.connection.id,
    status,
    applied,
    error: authError
      ? 'Moneybird rejected the connection — reconnect it'
      : state.errors[0] && `${state.counts.failed} item(s) could not be sent to Moneybird: ${state.errors[0].message}`,
    errorSamples: state.errors,
  });

  return {
    invoicesPushed: state.counts.invoices,
    statementsPushed: state.counts.statements,
    linesBooked: state.counts.lines,
    failed: state.counts.failed,
    remaining: state.remaining,
  };
}

/** Ask the cron for another pass in a few minutes (Moneybird rate limit), via the D1 work index. */
export async function scheduleMoneybirdPushBacklog(env: MoneybirdPushEnv, moneybirdConnectionId: string): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    const row = await d1
      .prepare('SELECT workspace_id, clerk_org_id FROM connector_sync_index WHERE connection_id = ? LIMIT 1')
      .bind(moneybirdConnectionId)
      .first<{ workspace_id: string; clerk_org_id: string }>();
    if (!row) return;
    await upsertTenantWorkIndex(d1, {
      workspaceId: row.workspace_id,
      clerkOrgId: row.clerk_org_id,
      kind: 'moneybird_push',
      nextDueAt: Date.now() + MONEYBIRD_PUSH_INTERVAL_MS,
    });
  } catch (err) {
    console.warn('[connectors/moneybird-push] schedule backlog failed:', err);
  }
}

function pushTargets(connections: ConnectorConnectionRow[], stripeConnectionId?: string): ConnectorConnectionRow[] {
  return connections.filter((connection) => {
    const settings = pushSettingsOf(connection);
    if (!settings?.enabled) return false;
    if (!stripeConnectionId || settings.sourceConnectionIds.length === 0) return true;
    return settings.sourceConnectionIds.includes(stripeConnectionId);
  });
}

/** Every Moneybird connection with sending on: one pass each. Returns whether any still has work. */
export async function pushAllMoneybirdConnections(args: {
  db: Database;
  env: MoneybirdPushEnv;
  trigger: 'manual' | 'schedule' | 'webhook';
  stripeConnectionId?: string;
}): Promise<{ remaining: boolean }> {
  const targets = pushTargets(await listConnectionsByProvider(args.db, 'moneybird'), args.stripeConnectionId);
  let remaining = false;
  for (const connection of targets) {
    try {
      const result = await pushToMoneybird({ db: args.db, env: args.env, connection, trigger: args.trigger });
      if (result.remaining) {
        remaining = true;
        await scheduleMoneybirdPushBacklog(args.env, connection.id);
      }
    } catch (err) {
      console.error(`[connectors/moneybird-push] pass failed for ${connection.id}:`, err);
    }
  }
  return { remaining };
}

/** After a Stripe import: send what it brought in. Never throws into the import. */
export async function pushAfterStripeIngest(args: {
  db: Database;
  env: MoneybirdPushEnv;
  stripeConnectionId: string;
}): Promise<void> {
  try {
    await pushAllMoneybirdConnections({
      db: args.db,
      env: args.env,
      trigger: 'webhook',
      stripeConnectionId: args.stripeConnectionId,
    });
  } catch (err) {
    console.error('[connectors/moneybird-push] after Stripe import failed:', err);
  }
}

// ------------------------------------------------------------------ status + options (UI)

export interface MoneybirdPushStatus {
  enabled: boolean;
  pushedInvoices: number;
  pendingInvoices: number;
  failedInvoices: number;
  pushedPayouts: number;
  pendingPayouts: number;
  lastRun: {
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
    errorSamples: Array<{ externalId: string; message: string }> | null;
  } | null;
}

async function countRows(db: Database, connectionId: string, type: string, state: 'done' | 'failed'): Promise<number> {
  const condition = state === 'failed'
    ? sql`${m.externalEntityId} like 'failed:%'`
    : sql`${m.externalEntityId} not like 'pending:%' and ${m.externalEntityId} not like 'failed:%'`;
  const [row] = await db
    .select({ total: count() })
    .from(m)
    .where(and(eq(m.connectionId, connectionId), eq(m.externalEntityType, type), condition));
  return Number(row?.total ?? 0);
}

export async function moneybirdPushStatus(db: Database, connection: ConnectorConnectionRow): Promise<MoneybirdPushStatus> {
  const settings = pushSettingsOf(connection);
  const sources = settings ? await sourceStripeConnectionIds(db, settings) : [];
  const stateLike = { connection, settings: settings ?? defaultPushSettings(), sources };

  let pendingInvoices = 0;
  let pendingPayouts = 0;
  if (sources.length > 0) {
    const [invoices] = await db
      .select({ total: sql<number>`count(distinct ${schema.invoices.id})` })
      .from(m)
      .innerJoin(schema.invoices, eq(schema.invoices.id, m.internalEntityId))
      .where(pendingInvoiceConditions(stateLike, false));
    pendingInvoices = Number(invoices?.total ?? 0);
    if (stateLike.settings.financialAccountId) {
      pendingPayouts = (await pendingPayoutIds(db, stateLike, false, 500)).length;
    }
  }

  const [lastRun] = await db
    .select()
    .from(schema.connectorSyncRuns)
    .where(and(eq(schema.connectorSyncRuns.connectionId, connection.id), eq(schema.connectorSyncRuns.syncName, MONEYBIRD_PUSH_SYNC_NAME)))
    .orderBy(desc(schema.connectorSyncRuns.createdAt))
    .limit(1);

  return {
    enabled: Boolean(settings?.enabled),
    pushedInvoices: await countRows(db, connection.id, MB_INVOICE_TYPE, 'done'),
    pendingInvoices,
    failedInvoices: await countRows(db, connection.id, MB_INVOICE_TYPE, 'failed'),
    pushedPayouts: await countRows(db, connection.id, MB_STATEMENT_TYPE, 'done'),
    pendingPayouts,
    lastRun: lastRun
      ? {
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          error: lastRun.error,
          errorSamples: lastRun.errorSamples,
        }
      : null,
  };
}

export function defaultPushSettings(): MoneybirdPushSettings {
  return {
    enabled: false,
    sourceConnectionIds: [],
    revenueLedgerAccountId: null,
    financialAccountId: null,
    feeLedgerAccountId: null,
    payoutLedgerAccountId: null,
    taxRateOverrides: { ...DEFAULT_TAX_OVERRIDES },
    startDate: null,
  };
}

export interface MoneybirdPushOptions {
  ledgerAccounts: MoneybirdLedgerAccount[];
  financialAccounts: Array<{ id: string; name: string; type: string | null; identifier: string | null; currency: string | null }>;
  taxRates: Array<{ id: string; name: string; percentage: number | null; taxRateType: string | null; country: string | null }>;
  stripeConnections: Array<{ id: string; displayName: string | null; externalAccountId: string | null }>;
}

/** What the settings form picks from: the administration's ledgers, accounts and sales tax rates. */
export async function moneybirdPushOptions(
  db: Database,
  env: MoneybirdPushEnv,
  connection: ConnectorConnectionRow,
): Promise<MoneybirdPushOptions> {
  const client = await moneybirdClientFor(env, connection);
  const [ledgerAccounts, financial, taxRates, stripe] = await Promise.all([
    client.listLedgerAccounts(),
    client.listFinancialAccounts(),
    client.listTaxRates(),
    listConnectionsByProvider(db, 'stripe'),
  ]);
  return {
    ledgerAccounts,
    financialAccounts: financial.items.map((row) => ({
      id: textId(row.id),
      name: typeof row.name === 'string' && row.name ? row.name : textId(row.identifier ?? row.id),
      type: typeof row.type === 'string' ? row.type : null,
      identifier: typeof row.identifier === 'string' ? row.identifier : null,
      currency: typeof row.currency === 'string' ? row.currency : null,
    })),
    taxRates: taxRates
      .filter((rate) => rate.active && (rate.taxRateType === 'sales_invoice' || rate.taxRateType === null))
      .map(({ id, name, percentage, taxRateType, country }) => ({ id, name, percentage, taxRateType, country })),
    stripeConnections: stripe.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      externalAccountId: row.externalAccountId,
    })),
  };
}
