/**
 * Recurring invoice routes — flat /api/recurring-invoices/* surface backed by
 * `recurringInvoices`.
 *
 * Ported from apps/api-worker/src/routes/accounting/recurring-invoices.ts:
 *   - Entity scoping via resolveEntityId (header/query/default).
 *   - Pause/resume lifecycle (PATCH /:id/pause | /:id/resume).
 *   - POST /:id/generate materialises the next invoice from the template,
 *     numbering it via nextEntityNumber(db, entityId, 'invoice'), and rolls
 *     nextIssueDate forward by the schedule frequency.
 *
 * Integrity: every mutation is written to the accounting audit log.
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { nextEntityNumber, resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const createRecurringSchema = z.object({
  name: z.string().max(255).optional(),
  contactId: z.string().min(1),
  frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'biannually', 'yearly']),
  dayOfMonth: z.number().min(1).max(31).optional(),
  nextIssueDate: z.string(),
  endDate: z.string().optional(),
  autoSend: z.boolean().optional(),
  autoFinalize: z.boolean().optional(),
  templateData: z.object({
    items: z.array(z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      unit: z.string().optional(),
      taxRateId: z.string().optional(),
      accountId: z.string().optional(),
    })).optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    paymentTermsDays: z.number().optional(),
    revenueAccountId: z.string().optional(),
    reference: z.string().optional(),
  }).optional(),
});

// GET / — legacy shape: plain array, no pagination envelope
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const results = await db
      .select()
      .from(schema.recurringInvoices)
      .where(and(isNull(schema.recurringInvoices.deletedAt), eq(schema.recurringInvoices.entityId, entityId)))
      .orderBy(desc(schema.recurringInvoices.createdAt));
    return success(c, results);
  } catch (err) {
    console.error('[app-api/recurring-invoices] list failed:', err);
    return error.internal(c, 'Failed to fetch recurring invoices');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);
    return success(c, rec);
  } catch (err) {
    console.error('[app-api/recurring-invoices] get failed:', err);
    return error.internal(c, 'Failed to fetch recurring invoice');
  }
});

// POST /
app.post('/', requirePermission('invoices:create'), zValidator('json', createRecurringSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const newRec = {
      id: generateId('ri'),
      entityId,
      ...data,
      nextIssueDate: new Date(data.nextIssueDate),
      endDate: data.endDate ? new Date(data.endDate) : null,
      status: 'active' as const,
      generatedCount: 0,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.recurringInvoices).values(newRec);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'recurring_invoice',
      entityId: newRec.id,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: newRec.id,
      action: 'created',
      data: newRec as unknown as Record<string, unknown>,
    });
    return success(c, newRec, 201);
  } catch (err) {
    console.error('[app-api/recurring-invoices] create failed:', err);
    return error.internal(c, 'Failed to create recurring invoice');
  }
});

// PUT /:id (PATCH alias kept for app-api clients)
app.on(['PUT', 'PATCH'], '/:id', requirePermission('invoices:update'), zValidator('json', createRecurringSchema.partial()), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);

    const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
    if (data.nextIssueDate) updateData.nextIssueDate = new Date(data.nextIssueDate);
    if (data.endDate) updateData.endDate = new Date(data.endDate);
    await db.update(schema.recurringInvoices).set(updateData).where(eq(schema.recurringInvoices.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(updateData)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (rec as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      data: { ...rec, ...updateData } as unknown as Record<string, unknown>,
    });
    return success(c, { ...rec, ...updateData });
  } catch (err) {
    console.error('[app-api/recurring-invoices] update failed:', err);
    return error.internal(c, 'Failed to update recurring invoice');
  }
});

// DELETE /:id
app.delete('/:id', requirePermission('invoices:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);

    await db.update(schema.recurringInvoices)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.recurringInvoices.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'recurring_invoice', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/recurring-invoices] delete failed:', err);
    return error.internal(c, 'Failed to delete recurring invoice');
  }
});

// PATCH /:id/pause
app.patch('/:id/pause', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);

    await db.update(schema.recurringInvoices)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(schema.recurringInvoices.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'paused',
      changes: { status: { old: rec.status, new: 'paused' } },
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      data: { id, status: 'paused' },
    });
    return success(c, { status: 'paused' });
  } catch (err) {
    console.error('[app-api/recurring-invoices] pause failed:', err);
    return error.internal(c, 'Failed to pause recurring invoice');
  }
});

// PATCH /:id/resume
app.patch('/:id/resume', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);

    await db.update(schema.recurringInvoices)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(schema.recurringInvoices.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'resumed',
      changes: { status: { old: rec.status, new: 'active' } },
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      data: { id, status: 'active' },
    });
    return success(c, { status: 'active' });
  } catch (err) {
    console.error('[app-api/recurring-invoices] resume failed:', err);
    return error.internal(c, 'Failed to resume recurring invoice');
  }
});

// POST /:id/generate — generate next invoice from recurring template
app.post('/:id/generate', requirePermission('invoices:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');

  try {
    const { recurringInvoices, invoices, invoiceItems, parties } = schema;

    const [rec] = await db.select().from(recurringInvoices)
      .where(and(eq(recurringInvoices.id, id), isNull(recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);
    if (rec.status !== 'active') return error.badRequest(c, 'Recurring invoice is not active');

    // Get contact info
    const [contact] = await db.select().from(parties)
      .where(and(eq(parties.id, rec.contactId), isNull(parties.deletedAt))).limit(1);

    const entityIdForNumbering = await resolveEntityId(c, db);
    if (!entityIdForNumbering) return error.badRequest(c, 'No accounting entity resolved');
    const { formatted: invoiceNumber } = await nextEntityNumber(db, entityIdForNumbering, 'invoice');

    const template = (rec.templateData || {}) as Record<string, any>;
    const items = (template.items || []) as Array<{ description: string; quantity: number; unitPrice: number; unit?: string; taxRateId?: string; accountId?: string }>;
    const paymentTermsDays = template.paymentTermsDays || rec.dayOfMonth || 30;

    // Calculate totals
    let subtotal = 0;
    let taxTotal = 0;
    const processedItems = items.map((item, idx) => {
      const qty = item.quantity || 1;
      const price = item.unitPrice || 0;
      const lineTotal = qty * price;
      subtotal += lineTotal;
      return {
        id: generateId('ili'),
        invoiceId: '', // will be set below
        description: item.description,
        quantity: String(qty),
        unitPrice: String(price),
        unit: item.unit || null,
        discountPercent: '0',
        taxRateId: item.taxRateId || null,
        taxRate: null as string | null,
        taxAmount: '0',
        lineTotal: lineTotal.toFixed(2),
        lineTotalWithTax: lineTotal.toFixed(2),
        accountId: item.accountId || template.revenueAccountId || null,
        sortOrder: idx,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    const total = subtotal + taxTotal;
    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + paymentTermsDays * 24 * 60 * 60 * 1000);

    const invoiceId = generateId('inv');
    await db.insert(invoices).values({
      id: invoiceId,
      entityId: entityIdForNumbering,
      invoiceNumber,
      type: 'standard',
      status: rec.autoFinalize ? 'sent' : 'draft',
      contactId: rec.contactId,
      contactName: contact?.displayName || null,
      contactEmail: null,
      issueDate,
      dueDate,
      currency: 'EUR',
      subtotal: subtotal.toFixed(2),
      discountTotal: '0',
      taxTotal: taxTotal.toFixed(2),
      total: total.toFixed(2),
      amountPaid: '0',
      balanceDue: total.toFixed(2),
      paymentTermsDays,
      reference: template.reference || null,
      notes: template.notes || null,
      internalNotes: template.internalNotes || null,
      recurringInvoiceId: id,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Insert items
    if (processedItems.length > 0) {
      await db.insert(invoiceItems).values(
        processedItems.map((item) => ({ ...item, entityId: entityIdForNumbering, invoiceId })),
      );
    }

    // Calculate next issue date based on frequency
    const currentNext = new Date(rec.nextIssueDate);
    const nextDate = new Date(currentNext);
    switch (rec.frequency) {
      case 'weekly': nextDate.setDate(nextDate.getDate() + 7); break;
      case 'biweekly': nextDate.setDate(nextDate.getDate() + 14); break;
      case 'monthly': nextDate.setMonth(nextDate.getMonth() + 1); break;
      case 'quarterly': nextDate.setMonth(nextDate.getMonth() + 3); break;
      case 'biannually': nextDate.setMonth(nextDate.getMonth() + 6); break;
      case 'yearly': nextDate.setFullYear(nextDate.getFullYear() + 1); break;
    }

    // Check if end date reached
    const newStatus = rec.endDate && nextDate > new Date(rec.endDate) ? 'completed' : 'active';

    // Update recurring invoice
    await db.update(recurringInvoices).set({
      nextIssueDate: nextDate,
      generatedCount: (rec.generatedCount || 0) + 1,
      lastGeneratedAt: new Date(),
      lastGeneratedInvoiceId: invoiceId,
      status: newStatus,
      updatedAt: new Date(),
    }).where(eq(recurringInvoices.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'generated',
      changes: {
        lastGeneratedInvoiceId: { old: rec.lastGeneratedInvoiceId, new: invoiceId },
        generatedCount: { old: rec.generatedCount, new: (rec.generatedCount || 0) + 1 },
        status: { old: rec.status, new: newStatus },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      data: { id, invoiceId, invoiceNumber, nextIssueDate: nextDate.toISOString(), status: newStatus, generatedCount: (rec.generatedCount || 0) + 1 },
    });
    return success(c, { invoiceId, invoiceNumber, nextIssueDate: nextDate.toISOString(), status: newStatus }, 201);
  } catch (err) {
    console.error('[app-api/recurring-invoices] generate failed:', err);
    return error.internal(c, 'Failed to generate recurring invoice');
  }
});

export const recurringInvoicesRoutes = app;
