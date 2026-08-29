/**
 * Personal mail accounts — list + get by id.
 */

import { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  try {
    const personalDb = getPersonalDb(c.env);
    const rows = await personalDb
      .select()
      .from(personalSchema.personalMailAccounts)
      .where(
        and(
          eq(personalSchema.personalMailAccounts.personalAccountId, personalAccountId),
          isNull(personalSchema.personalMailAccounts.deletedAt),
        ),
      )
      .orderBy(desc(personalSchema.personalMailAccounts.createdAt));

    return success(c, rows);
  } catch (err) {
    console.error('[personal-api/mail-accounts] list failed:', err);
    return error.internal(c, 'Failed to list mail accounts');
  }
});

app.get('/:id', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');

  try {
    const personalDb = getPersonalDb(c.env);
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalMailAccounts)
      .where(
        and(
          eq(personalSchema.personalMailAccounts.id, id),
          eq(personalSchema.personalMailAccounts.personalAccountId, personalAccountId),
          isNull(personalSchema.personalMailAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return error.notFound(c, 'Mail account', id);
    return success(c, row);
  } catch (err) {
    console.error('[personal-api/mail-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch mail account');
  }
});

export const mailAccountsRoutes = app;
