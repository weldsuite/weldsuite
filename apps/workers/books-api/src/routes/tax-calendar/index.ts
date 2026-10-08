/**
 * Tax due-date calendar — /api/tax-calendar.
 *
 *   GET    /?year=                        the entity's deadlines of a calendar year (income tax, estimated tax,
 *                                         1099s, payroll, sales tax per agency), each with its completion state;
 *                                         `supported: false` and no items for an entity outside the US
 *   POST   /complete                      {deadlineKey, dueDate, notes?} mark a deadline done
 *   DELETE /complete/:deadlineKey         take the mark off
 *
 * A sales tax deadline (`sales_tax:<agencyId>:<periodEnd>`) is done when its return is filed. Marks and unmarks
 * are written to the accounting audit log (the entity events have no calendar object).
 *
 * Permissions: taxes:read; taxes:update to mark or unmark a deadline.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { eq } from 'drizzle-orm';
import { resolveEntityId } from '../../lib/entity-context';
import { todayIn } from '../../services/sales-tax-returns/common';
import { completeDeadline, entityCalendar, uncompleteDeadline } from '../../services/tax-calendar';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const completeSchema = z.object({
  deadlineKey: z.string().regex(/^[A-Za-z0-9_:.-]{1,120}$/, 'Use the key of a calendar deadline'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date'),
  notes: z.string().max(2000).optional(),
});

async function entityOf(c: Ctx) {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return null;
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId)).limit(1);
  return entity ?? null;
}

// GET /?year=
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await entityOf(c);
    if (!entity) return error.badRequest(c, 'No accounting entity resolved');
    const requested = c.req.query('year');
    const year = requested ? Number.parseInt(requested, 10) : Number.parseInt(todayIn(entity.timezone).slice(0, 4), 10);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return error.badRequest(c, 'year must be between 2000 and 2100');
    return success(c, await entityCalendar(db, entity, year));
  } catch (err) {
    console.error('[books-api/tax-calendar] fetch failed:', err);
    return error.internal(c, 'Failed to fetch the tax calendar');
  }
});

// POST /complete
app.post('/complete', requirePermission('taxes:update'), zValidator('json', completeSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await entityOf(c);
    if (!entity) return error.badRequest(c, 'No accounting entity resolved');
    if (entity.jurisdictionCode !== 'US') return error.badRequest(c, 'The tax calendar covers US entities only');
    const row = await completeDeadline(db, {
      entityId: entity.id,
      deadlineKey: data.deadlineKey,
      dueDate: data.dueDate,
      notes: data.notes ?? null,
      userId: c.get('userId') ?? null,
    });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'tax_calendar_completion',
      entityId: row.id,
      action: 'completed',
      changes: { deadlineKey: { old: null, new: data.deadlineKey } },
    });
    return success(
      c,
      { id: row.id, deadlineKey: row.deadlineKey, dueDate: row.dueDate, completedBy: row.completedBy, completedAt: row.createdAt, notes: row.notes },
      201,
    );
  } catch (err) {
    console.error('[books-api/tax-calendar] complete failed:', err);
    return error.internal(c, 'Failed to mark the deadline done');
  }
});

// DELETE /complete/:deadlineKey
app.delete('/complete/:deadlineKey', requirePermission('taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  const key = c.req.param('deadlineKey') ?? '';
  try {
    const entity = await entityOf(c);
    if (!entity) return error.badRequest(c, 'No accounting entity resolved');
    const removed = await uncompleteDeadline(db, entity.id, key);
    if (!removed) return error.notFound(c, 'Completion', key);
    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'tax_calendar_completion',
      entityId: key,
      action: 'reopened',
      changes: { deadlineKey: { old: key, new: null } },
    });
    return noContent(c);
  } catch (err) {
    console.error('[books-api/tax-calendar] reopen failed:', err);
    return error.internal(c, 'Failed to reopen the deadline');
  }
});

export const taxCalendarRoutes = app;
