/**
 * GET /api/me — personal account + mail accounts + calendars (or empty if not onboarded).
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { error, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const account = c.get('personalAccount');

  if (!account) {
    return success(c, {
      account: null,
      mailAccounts: [],
      calendars: [],
      entitlements: c.get('entitlements'),
    });
  }

  try {
    const personalDb = getPersonalDb(c.env);
    const [mailAccounts, calendars] = await Promise.all([
      personalDb
        .select({
          id: personalSchema.personalMailAccounts.id,
          email: personalSchema.personalMailAccounts.email,
          name: personalSchema.personalMailAccounts.name,
          displayName: personalSchema.personalMailAccounts.displayName,
          provider: personalSchema.personalMailAccounts.provider,
          status: personalSchema.personalMailAccounts.status,
          isDefault: personalSchema.personalMailAccounts.isDefault,
          createdAt: personalSchema.personalMailAccounts.createdAt,
        })
        .from(personalSchema.personalMailAccounts)
        .where(
          and(
            eq(personalSchema.personalMailAccounts.personalAccountId, account.id),
            isNull(personalSchema.personalMailAccounts.deletedAt),
          ),
        ),
      personalDb
        .select({
          id: personalSchema.personalCalendars.id,
          name: personalSchema.personalCalendars.name,
          color: personalSchema.personalCalendars.color,
          isDefault: personalSchema.personalCalendars.isDefault,
        })
        .from(personalSchema.personalCalendars)
        .where(
          and(
            eq(personalSchema.personalCalendars.personalAccountId, account.id),
            isNull(personalSchema.personalCalendars.deletedAt),
          ),
        ),
    ]);

    return success(c, {
      account,
      mailAccounts,
      calendars,
      entitlements: c.get('entitlements'),
    });
  } catch (err) {
    console.error('[personal-api/me] failed:', err);
    return error.internal(c, 'Failed to load profile');
  }
});

export const meRoutes = app;
