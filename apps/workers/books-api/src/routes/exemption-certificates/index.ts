/**
 * Sales tax exemption certificates a customer gave the entity (resale,
 * nonprofit, government, ...). /api/exemption-certificates/*
 *
 * A valid certificate covering the ship-to state on the invoice date zeroes the
 * tax; the sale still counts as gross and exempt sales on the return. The
 * status is computed on every read: a certificate is `expired` once its own
 * expiry date, or the state's rule for certificates without one (Florida's
 * annual resale certificate, Washington's 48 months, an SST blanket
 * certificate unused for 12 months), has passed in every state it covers.
 *
 * Permissions: taxes:read | taxes:create | taxes:update | taxes:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, max, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { certificateExpiry } from '@weldsuite/books-domain/sales-tax';
import { toCertificateRef } from '@weldsuite/books-domain/sales-tax/load';
import { addDays } from '@weldsuite/books-domain/sales-tax/dates';
import { getUsState } from '@weldsuite/books-domain/jurisdictions/us/states';
import { salesTaxErrorResponse, SalesTaxSetupError } from '../../services/sales-tax/errors';
import {
  checkDateOrder,
  isoDateSchema,
  optionalSalesTaxEntity,
  pageParams,
  requireSalesTaxEntity,
} from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type CertificateRow = typeof schema.exemptionCertificates.$inferSelect;

const reasonSchema = z.enum(['resale', 'nonprofit', 'government', 'manufacturing', 'agricultural', 'other']);
const formSchema = z.enum(['sst_f0003', 'mtc_uniform', 'state_form', 'other']);
const statusSchema = z.enum(['valid', 'expired', 'pending', 'revoked']);

const createCertificateSchema = z.object({
  partyId: z.string().min(1).max(30),
  states: z.array(z.string().length(2)).min(1).max(60),
  reason: reasonSchema,
  certificateNumber: z.string().max(100).nullish(),
  form: formSchema.optional(),
  issuedOn: isoDateSchema.nullish(),
  expiresOn: isoDateSchema.nullish(),
  /** Covers every purchase (default); a single-purchase certificate names its invoice. */
  blanket: z.boolean().optional(),
  invoiceId: z.string().max(30).nullish(),
  /** The scanned certificate: an accounting document id. */
  documentId: z.string().max(30).nullish(),
  status: statusSchema.optional(),
  receivedOn: isoDateSchema.nullish(),
  notes: z.string().max(5000).nullish(),
});

const updateCertificateSchema = createCertificateSchema.omit({ partyId: true }).partial();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeStates(states: string[]): string[] {
  const codes = [...new Set(states.map((s) => s.trim().toUpperCase()))];
  const unknown = codes.filter((code) => !getUsState(code));
  if (unknown.length > 0) throw new SalesTaxSetupError(`Unknown US state code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return codes;
}

/** Checks that need the database: the customer, the invoice and the scan exist. */
async function checkReferences(
  db: Database,
  entityId: string,
  refs: { partyId?: string; invoiceId?: string | null; documentId?: string | null },
): Promise<void> {
  if (refs.partyId) {
    const [party] = await db.select({ id: schema.parties.id }).from(schema.parties).where(eq(schema.parties.id, refs.partyId)).limit(1);
    if (!party) throw new SalesTaxSetupError(`Customer ${refs.partyId} not found`);
  }
  if (refs.invoiceId) {
    const [invoice] = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, refs.invoiceId), eq(schema.invoices.entityId, entityId), isNull(schema.invoices.deletedAt)))
      .limit(1);
    if (!invoice) throw new SalesTaxSetupError(`Invoice ${refs.invoiceId} not found`);
  }
  if (refs.documentId) {
    const [doc] = await db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, refs.documentId), isNull(schema.documents.deletedAt)))
      .limit(1);
    if (!doc) throw new SalesTaxSetupError(`Document ${refs.documentId} not found`);
  }
}

/** The tax date of the last sale made on each certificate (the SST blanket rule reads it). */
async function lastUsedByCertificate(db: Database, entityId: string, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ certificateId: schema.taxLines.certificateId, lastUsedOn: max(schema.taxLines.taxDate) })
    .from(schema.taxLines)
    .where(and(eq(schema.taxLines.entityId, entityId), inArray(schema.taxLines.certificateId, ids)))
    .groupBy(schema.taxLines.certificateId);
  return new Map(rows.flatMap((r) => (r.certificateId ? [[r.certificateId, r.lastUsedOn] as [string, string | null]] : [])));
}

/** The certificate as the API returns it, with its status worked out for today. */
export function presentCertificate(row: CertificateRow, lastUsedOn: string | null | undefined, day = today()) {
  const ref = toCertificateRef(row, lastUsedOn);
  const expiryByState: Record<string, string | null> = {};
  for (const state of ref.states) expiryByState[state] = certificateExpiry(ref, state);
  const expiries = Object.values(expiryByState);
  const expiredStates = ref.states.filter((s) => expiryByState[s] !== null && (expiryByState[s] as string) < day);
  const allExpired = ref.states.length > 0 && expiredStates.length === ref.states.length;
  // Stored revoked / pending stand; a valid one lapses when every state it covers has lapsed.
  const status = row.status === 'revoked' || row.status === 'pending' ? row.status : allExpired || row.status === 'expired' ? 'expired' : 'valid';
  // The last day it is valid anywhere; null when it doesn't expire in some state.
  const effectiveExpiresOn = expiries.length > 0 && expiries.every((e) => e !== null) ? [...(expiries as string[])].sort().at(-1) ?? null : null;
  const daysUntilExpiry =
    effectiveExpiresOn === null ? null : Math.round((Date.parse(`${effectiveExpiresOn}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return {
    ...row,
    status,
    storedStatus: row.status,
    expiryByState,
    expiredStates,
    effectiveExpiresOn,
    daysUntilExpiry,
    lastUsedOn: lastUsedOn ?? null,
  };
}

function eventData(row: CertificateRow, status?: string) {
  return { id: row.id, partyId: row.partyId, states: row.states, reason: row.reason, status: status ?? row.status };
}

async function requireCertificate(db: Database, entityId: string, id: string): Promise<CertificateRow> {
  const [row] = await db
    .select()
    .from(schema.exemptionCertificates)
    .where(
      and(
        eq(schema.exemptionCertificates.id, id),
        eq(schema.exemptionCertificates.entityId, entityId),
        isNull(schema.exemptionCertificates.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new SalesTaxSetupError(`Exemption certificate ${id} not found`, 404);
  return row;
}

// GET / — ?partyId=&status=&expiringWithinDays=
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.exemptionCertificates;
  try {
    const entity = await optionalSalesTaxEntity(c, db);
    if (!entity) return list(c, [], cursorPagination(0, false, null));
    const { page, pageSize, offset } = pageParams(c);

    const conditions: SQL[] = [eq(t.entityId, entity.id), isNull(t.deletedAt)];
    const partyId = c.req.query('partyId');
    if (partyId) conditions.push(eq(t.partyId, partyId));
    const rows = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.createdAt));

    // Status depends on today and on the last sale, so filter after computing it.
    const lastUsed = await lastUsedByCertificate(db, entity.id, rows.map((r) => r.id));
    let presented = rows.map((row) => presentCertificate(row, lastUsed.get(row.id)));
    const status = c.req.query('status');
    if (status) presented = presented.filter((r) => r.status === status);
    const within = Number.parseInt(c.req.query('expiringWithinDays') ?? '', 10);
    if (Number.isFinite(within) && within >= 0) {
      const limit = addDays(today(), within);
      presented = presented.filter(
        (r) => r.status === 'valid' && r.effectiveExpiresOn !== null && r.effectiveExpiresOn >= today() && r.effectiveExpiresOn <= limit,
      );
      presented.sort((a, b) => (a.effectiveExpiresOn ?? '').localeCompare(b.effectiveExpiresOn ?? ''));
    }

    const page$ = presented.slice(offset, offset + pageSize);
    return list(c, page$, cursorPagination(presented.length, offset + pageSize < presented.length, null));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/exemption-certificates] list failed:', err);
    return error.internal(c, 'Failed to fetch exemption certificates');
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireCertificate(db, entity.id, c.req.param('id'));
    const lastUsed = await lastUsedByCertificate(db, entity.id, [row.id]);
    return success(c, presentCertificate(row, lastUsed.get(row.id)));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/exemption-certificates] get failed:', err);
    return error.internal(c, 'Failed to fetch exemption certificate');
  }
});

// POST /
app.post('/', requirePermission('taxes:create'), zValidator('json', createCertificateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const states = normalizeStates(data.states);
    if (data.issuedOn) checkDateOrder(data.issuedOn, data.expiresOn, 'the certificate');
    await checkReferences(db, entity.id, { partyId: data.partyId, invoiceId: data.invoiceId, documentId: data.documentId });

    const blanket = data.blanket ?? true;
    if (blanket && data.invoiceId) throw new SalesTaxSetupError('A blanket certificate covers every purchase; leave the invoice empty, or mark it single-purchase');

    const now = new Date();
    const row = {
      id: generateId('exc'),
      entityId: entity.id,
      partyId: data.partyId,
      states,
      reason: data.reason,
      certificateNumber: data.certificateNumber?.trim() || null,
      form: data.form ?? 'state_form',
      issuedOn: data.issuedOn ?? null,
      expiresOn: data.expiresOn ?? null,
      blanket,
      invoiceId: data.invoiceId ?? null,
      documentId: data.documentId ?? null,
      status: data.status ?? 'valid',
      receivedOn: data.receivedOn ?? today(),
      notes: data.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.exemptionCertificates).values(row);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'exemption_certificate',
      entityId: row.id,
      action: 'created',
    });
    const presented = presentCertificate(row as CertificateRow, null);
    publishEntityEvent({ c, entityType: 'exemption_certificate', entityId: row.id, action: 'created', data: eventData(row as CertificateRow, presented.status) });
    return success(c, presented, 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/exemption-certificates] create failed:', err);
    return error.internal(c, 'Failed to create exemption certificate');
  }
});

// PUT/PATCH /:id
app.on(['PUT', 'PATCH'], '/:id', requirePermission('taxes:update'), zValidator('json', updateCertificateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireCertificate(db, entity.id, c.req.param('id'));
    const issuedOn = data.issuedOn === undefined ? row.issuedOn : data.issuedOn;
    const expiresOn = data.expiresOn === undefined ? row.expiresOn : data.expiresOn;
    if (issuedOn) checkDateOrder(issuedOn, expiresOn, 'the certificate');
    await checkReferences(db, entity.id, { invoiceId: data.invoiceId, documentId: data.documentId });

    const update: Partial<CertificateRow> = { updatedAt: new Date() };
    if (data.states !== undefined) update.states = normalizeStates(data.states);
    if (data.reason !== undefined) update.reason = data.reason;
    if (data.certificateNumber !== undefined) update.certificateNumber = data.certificateNumber?.trim() || null;
    if (data.form !== undefined) update.form = data.form;
    if (data.issuedOn !== undefined) update.issuedOn = data.issuedOn ?? null;
    if (data.expiresOn !== undefined) update.expiresOn = data.expiresOn ?? null;
    if (data.blanket !== undefined) update.blanket = data.blanket;
    if (data.invoiceId !== undefined) update.invoiceId = data.invoiceId ?? null;
    if (data.documentId !== undefined) update.documentId = data.documentId ?? null;
    if (data.status !== undefined) update.status = data.status;
    if (data.receivedOn !== undefined) update.receivedOn = data.receivedOn ?? null;
    if (data.notes !== undefined) update.notes = data.notes ?? null;
    await db.update(schema.exemptionCertificates).set(update).where(eq(schema.exemptionCertificates.id, row.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'exemption_certificate',
      entityId: row.id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (row as Record<string, unknown>)[k], new: v }]),
      ),
    });
    const updated = { ...row, ...update };
    const lastUsed = await lastUsedByCertificate(db, entity.id, [row.id]);
    const presented = presentCertificate(updated, lastUsed.get(row.id));
    publishEntityEvent({ c, entityType: 'exemption_certificate', entityId: row.id, action: 'updated', data: eventData(updated, presented.status) });
    return success(c, presented);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/exemption-certificates] update failed:', err);
    return error.internal(c, 'Failed to update exemption certificate');
  }
});

// DELETE /:id — soft delete (sales already made on it keep pointing at it)
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireCertificate(db, entity.id, c.req.param('id'));
    const now = new Date();
    await db
      .update(schema.exemptionCertificates)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.exemptionCertificates.id, row.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'exemption_certificate',
      entityId: row.id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'exemption_certificate', entityId: row.id, action: 'deleted', data: eventData(row) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/exemption-certificates] delete failed:', err);
    return error.internal(c, 'Failed to delete exemption certificate');
  }
});

export const exemptionCertificatesRoutes = app;
