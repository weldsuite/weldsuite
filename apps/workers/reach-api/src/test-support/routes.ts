/**
 * Route-test helper: mounts a reach router behind the kit's stub auth and sets
 * what `appAccessGate` would (the staff-set limits), so routes that read
 * `c.get('appAccess')` see a realistic value.
 */

import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import type { Database } from '@weldsuite/worker-kit';
import type { WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../types';

export interface ReachAppOptions {
  /** Permission keys granted to the test user ('*' = everything). */
  permissions: string[];
  db: Database;
  limits?: Partial<WeldReachLimits>;
  env?: Partial<Env>;
  userId?: string;
}

export function reachApp(mount: string, router: Hono<{ Bindings: Env; Variables: Variables }>, options: ReachAppOptions) {
  return createTestApp<Env, Variables>(mount, router, {
    context: {
      // What appAccessGate would set: the staff-set limits.
      appAccess: {
        workspaceId: 'ws_test',
        status: 'approved',
        limits: { ...options.limits },
        billingStatus: 'active',
        billingStatusAt: null,
      },
      permissions: permissions(...options.permissions),
      tenantDb: options.db,
      ...(options.userId ? { userId: options.userId } : {}),
    },
    env: options.env,
  });
}

export const asJson = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
