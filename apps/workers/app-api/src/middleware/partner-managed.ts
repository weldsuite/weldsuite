/**
 * Refuse a billing mutation on a partner-managed workspace.
 *
 * A managed workspace is billed to its partner: it has no Stripe customer or
 * subscription of its own, and its owner must not start one (checkout, seat
 * purchases, payment methods, credit top-ups). Mount after `apiAuth()`.
 */

import { createMiddleware } from 'hono/factory';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';
import { getManagedContext, partnerManagedResponse } from '../services/partner/managed';

export const blockPartnerManaged = () =>
  createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const orgId = c.get('orgId');
    if (orgId) {
      const managed = await getManagedContext(getMasterDb(c.env), orgId);
      if (managed) return partnerManagedResponse(c, managed.partner);
    }
    await next();
  });
