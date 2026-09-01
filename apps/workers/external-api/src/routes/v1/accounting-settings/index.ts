import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { updateAccountingSettingsSchema } from '@weldsuite/app-api-client/schemas/accounting-settings';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, success } from '../../../lib/response';

const table = schema.settings;
const app = new Hono<HonoEnv>();

/** Singleton workspace accounting settings (`settings` table). */
app.get('/', requireScope('accounting_settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const [row] = await db.select().from(table).where(isNull(table.deletedAt)).limit(1);
  if (row) return success(c, row);

  const now = new Date();
  const id = generateId('acs');
  const [created] = await db
    .insert(table)
    .values({ id, createdAt: now, updatedAt: now })
    .returning();
  return success(c, created, 201);
});

app.patch('/', requireScope('accounting_settings:write'), zValidator('json', updateAccountingSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const [existing] = await db.select().from(table).where(isNull(table.deletedAt)).limit(1);
  const now = new Date();

  if (!existing) {
    const id = generateId('acs');
    const [created] = await db
      .insert(table)
      .values({ id, ...body, createdAt: now, updatedAt: now })
      .returning();
    publishEntityEvent({
      c,
      entityType: 'accounting_settings',
      entityId: id,
      action: 'updated',
      data: created as unknown as Record<string, unknown>,
    });
    return success(c, created, 201);
  }

  const [row] = await db
    .update(table)
    .set({ ...body, updatedAt: now })
    .where(and(eq(table.id, existing.id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update accounting settings');
  publishEntityEvent({
    c,
    entityType: 'accounting_settings',
    entityId: existing.id,
    action: 'updated',
    data: row as unknown as Record<string, unknown>,
  });
  return success(c, row);
});

export default app;
