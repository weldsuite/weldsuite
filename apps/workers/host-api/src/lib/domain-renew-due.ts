/**
 * Keeps the daily auto-renew sweep's D1 due index (`workspace_due_index`, kind
 * `domain_renew`) in step with domain writes.
 *
 * Mounted after the auth chain on /api/domains and /api/domain-transfers:
 * every successful write there (register, transfer in, auto-renew switched
 * on, renewal, …) marks the workspace due for the next run. The sweep then
 * re-derives the exact next time from the tenant (`nextDomainRenewCheckAt`),
 * so marking too often costs one extra tenant visit at most — while a domain
 * that will need renewing can never be missed by a write path nobody hooked.
 */

import type { MiddlewareHandler } from 'hono';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { Env, Variables } from '../types';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const markDomainRenewDue: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  await next();
  if (READ_METHODS.has(c.req.method) || !c.res.ok) return;
  await markWorkspaceDue(c.env.SCHEDULE_INDEX, 'domain_renew', c.get('workspaceId'));
};
