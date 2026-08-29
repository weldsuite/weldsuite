/**
 * Personal mail labels — list by accountId.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  accountId: z.string().min(1),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const { accountId } = c.req.valid('query');

  try {
    const personalDb = getPersonalDb(c.env);

    const [account] = await personalDb
      .select({ id: personalSchema.personalMailAccounts.id })
      .from(personalSchema.personalMailAccounts)
      .where(
        and(
          eq(personalSchema.personalMailAccounts.id, accountId),
          eq(personalSchema.personalMailAccounts.personalAccountId, personalAccountId),
          isNull(personalSchema.personalMailAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (!account) return error.notFound(c, 'Mail account', accountId);

    const rows = await personalDb
      .select()
      .from(personalSchema.personalMailLabels)
      .where(
        and(
          eq(personalSchema.personalMailLabels.personalAccountId, personalAccountId),
          eq(personalSchema.personalMailLabels.accountId, accountId),
          isNull(personalSchema.personalMailLabels.deletedAt),
        ),
      )
      .orderBy(asc(personalSchema.personalMailLabels.position), asc(personalSchema.personalMailLabels.name));

    return success(c, rows);
  } catch (err) {
    console.error('[personal-api/mail-labels] list failed:', err);
    return error.internal(c, 'Failed to list labels');
  }
});

export const mailLabelsRoutes = app;
