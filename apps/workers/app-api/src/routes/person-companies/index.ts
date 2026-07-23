/**
 * Person ↔ Company junction routes — /api/person-companies/*.
 *
 * Direct CRUD on the link table. Used by the company panel's People tab
 * and the person panel's Companies tab to link / unlink / promote primary
 * employment.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Context } from 'hono';

function publishBothSides(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  personId: string,
  companyId: string,
) {
  publishEntityEvent({
    c,
    entityType: 'person',
    entityId: personId,
    action: 'updated',
    data: { id: personId },
  });
  publishEntityEvent({
    c,
    entityType: 'company',
    entityId: companyId,
    action: 'updated',
    data: { id: companyId },
  });
}
import {
  createPersonCompanySchema,
  updatePersonCompanySchema,
} from '@weldsuite/core-api-client/schemas/person-companies';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.personCompanies;

app.post('/', requirePermission('contacts:update'), zValidator('json', createPersonCompanySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('pc');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      createdAt: now,
      updatedAt: now,
      personId: data.personId,
      companyId: data.companyId,
      role: data.role ?? null,
      isPrimary: data.isPrimary ?? false,
      startedAt: data.startedAt ? new Date(data.startedAt) : null,
      endedAt: data.endedAt ? new Date(data.endedAt) : null,
    });
    if (data.isPrimary) {
      await db
        .update(t)
        .set({ isPrimary: false, updatedAt: now })
        .where(and(eq(t.personId, data.personId), ne(t.id, id)));
    }
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishBothSides(c, data.personId, data.companyId);
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/person-companies] create failed:', err);
    return error.internal(c, 'Failed to link person to company');
  }
});

app.patch('/:id', requirePermission('contacts:update'), zValidator('json', updatePersonCompanySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'PersonCompany', id);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.role !== undefined) updates.role = data.role;
    if (data.isPrimary !== undefined) updates.isPrimary = data.isPrimary;
    if (data.startedAt !== undefined) updates.startedAt = data.startedAt ? new Date(data.startedAt) : null;
    if (data.endedAt !== undefined) updates.endedAt = data.endedAt ? new Date(data.endedAt) : null;

    await db.update(t).set(updates).where(eq(t.id, id));

    if (data.isPrimary === true) {
      await db
        .update(t)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(t.personId, existing.personId), ne(t.id, id)));
    }

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishBothSides(c, existing.personId, existing.companyId);
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/person-companies] update failed:', err);
    return error.internal(c, 'Failed to update affiliation');
  }
});

app.delete('/:id', requirePermission('contacts:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select({ id: t.id, personId: t.personId, companyId: t.companyId })
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    if (!existing) return error.notFound(c, 'PersonCompany', id);
    await db.delete(t).where(eq(t.id, id));
    publishBothSides(c, existing.personId, existing.companyId);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/person-companies] delete failed:', err);
    return error.internal(c, 'Failed to unlink');
  }
});

export const personCompaniesRoutes = app;
