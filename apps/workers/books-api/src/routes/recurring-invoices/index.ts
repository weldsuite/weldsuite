/**
 * Recurring invoice routes — flat /api/recurring-invoices/* surface backed by
 * `recurringInvoices`.
 *
 * Ported from apps/api-worker/src/routes/accounting/recurring-invoices.ts:
 *   - Entity scoping via resolveEntityId (header/query/default).
 *   - Pause/resume lifecycle (PATCH /:id/pause | /:id/resume).
 *   - POST /:id/generate materialises the next invoice from the template
 *     (services/accounting-recurring): claims the period so it can't be billed
 *     twice, calculates tax like a manual invoice, and finalizes (posts) it
 *     when the schedule has autoFinalize. The daily cron uses the same service.
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
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import {
  generateRecurringInvoice,
  RecurringAlreadyGeneratedError,
  recurringTemplateSchema,
} from '../../services/accounting-recurring';
import { PostingError } from '../../services/accounting-posting';
import { TaxCalculationError } from '../../services/accounting-tax-resolve';

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
  templateData: recurringTemplateSchema.optional(),
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

// POST /:id/generate — generate the next invoice from the recurring template
app.post('/:id/generate', requirePermission('invoices:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId') ?? null;

  try {
    const [rec] = await db.select().from(schema.recurringInvoices)
      .where(and(eq(schema.recurringInvoices.id, id), isNull(schema.recurringInvoices.deletedAt))).limit(1);
    if (!rec) return error.notFound(c, 'Recurring invoice', id);
    if (rec.status !== 'active') return error.badRequest(c, 'Recurring invoice is not active');

    const resolvedEntityId = await resolveEntityId(c, db);
    if (resolvedEntityId && rec.entityId && rec.entityId !== resolvedEntityId) {
      return error.badRequest(c, 'Recurring invoice belongs to a different accounting entity');
    }

    const generated = await generateRecurringInvoice(db, rec, { userId });

    await writeAccountingAudit(c, db, {
      accountingEntityId: rec.entityId,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'generated',
      changes: {
        lastGeneratedInvoiceId: { old: rec.lastGeneratedInvoiceId, new: generated.invoiceId },
        generatedCount: { old: rec.generatedCount, new: (rec.generatedCount || 0) + 1 },
        status: { old: rec.status, new: generated.status },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'recurring_invoice',
      entityId: id,
      action: 'updated',
      data: {
        id,
        invoiceId: generated.invoiceId,
        invoiceNumber: generated.invoiceNumber,
        nextIssueDate: generated.nextIssueDate.toISOString(),
        status: generated.status,
        generatedCount: (rec.generatedCount || 0) + 1,
      },
    });
    return success(c, {
      invoiceId: generated.invoiceId,
      invoiceNumber: generated.invoiceNumber,
      nextIssueDate: generated.nextIssueDate.toISOString(),
      status: generated.status,
      journalEntryId: generated.journalEntryId,
      finalizeError: generated.finalizeError,
    }, 201);
  } catch (err) {
    if (err instanceof RecurringAlreadyGeneratedError) return error.conflict(c, err.message);
    if (err instanceof PostingError || err instanceof TaxCalculationError) return error.badRequest(c, err.message);
    console.error('[books-api/recurring-invoices] generate failed:', err);
    return error.internal(c, 'Failed to generate recurring invoice');
  }
});

export const recurringInvoicesRoutes = app;
