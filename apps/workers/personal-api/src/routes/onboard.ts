/**
 * POST /api/onboard — idempotent personal account creation.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '../db';
import { generateId } from '../lib/id';
import { error, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const onboardBody = z.object({
  displayName: z.string().min(1).max(255).optional(),
});

app.post('/', async (c) => {
  const userId = c.get('userId');
  let displayName: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = onboardBody.safeParse(body ?? {});
    if (!parsed.success) {
      return error.badRequest(c, 'Invalid body', parsed.error.flatten());
    }
    displayName = parsed.data.displayName;
  } catch {
    displayName = undefined;
  }
  const existing = c.get('personalAccount');

  if (existing) {
    return success(c, existing);
  }

  try {
    const masterDb = getMasterDb(c.env);

    // Race-safe: another request may have created the row between middleware and here.
    const [found] = await masterDb
      .select({
        id: masterSchema.personalAccounts.id,
        clerkUserId: masterSchema.personalAccounts.clerkUserId,
        displayName: masterSchema.personalAccounts.displayName,
      })
      .from(masterSchema.personalAccounts)
      .where(eq(masterSchema.personalAccounts.clerkUserId, userId))
      .limit(1);

    if (found) {
      return success(c, found);
    }

    const id = generateId('pa');
    const now = new Date();
    const [created] = await masterDb
      .insert(masterSchema.personalAccounts)
      .values({
        id,
        clerkUserId: userId,
        displayName: displayName ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: masterSchema.personalAccounts.id,
        clerkUserId: masterSchema.personalAccounts.clerkUserId,
        displayName: masterSchema.personalAccounts.displayName,
      });

    return success(c, created!, 201);
  } catch (err) {
    // Unique constraint on clerk_user_id — treat as idempotent success.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      try {
        const masterDb = getMasterDb(c.env);
        const [found] = await masterDb
          .select({
            id: masterSchema.personalAccounts.id,
            clerkUserId: masterSchema.personalAccounts.clerkUserId,
            displayName: masterSchema.personalAccounts.displayName,
          })
          .from(masterSchema.personalAccounts)
          .where(eq(masterSchema.personalAccounts.clerkUserId, userId))
          .limit(1);
        if (found) return success(c, found);
      } catch {
        // fall through
      }
    }
    console.error('[personal-api/onboard] failed:', err);
    return error.internal(c, 'Failed to onboard personal account');
  }
});

export const onboardRoutes = app;
