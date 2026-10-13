/**
 * Route-test helpers: the harness's stub auth does not set what
 * `appAccessGate('weldreach')` sets, so a router under test is wrapped in a
 * middleware that does. Used only by `*.test.ts`.
 */

import { Hono } from 'hono';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { Env, Variables } from '../../types';

export function approvedAccess(overrides: Partial<AppAccess> = {}): AppAccess {
  return {
    workspaceId: 'ws_acme',
    status: 'approved',
    limits: {},
    billingStatus: 'active',
    billingStatusAt: null,
    ...overrides,
  };
}

/** `router` behind a middleware that sets `c.get('appAccess')`, like the gate does. */
export function withAppAccess(router: Hono<{ Bindings: Env; Variables: Variables }>, access: AppAccess = approvedAccess()) {
  const wrapper = new Hono<{ Bindings: Env; Variables: Variables }>();
  wrapper.use('*', async (c, next) => {
    c.set('appAccess', access);
    await next();
  });
  wrapper.route('/', router);
  return wrapper;
}

/** A DNS-over-HTTPS answer for the resolver in `@weldsuite/worker-kit/dns-lookup`. */
export function dohResponse(name: string, type: string, values: string[]): Response {
  const codes: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
  const wire = (data: string) => {
    if (type === 'TXT') return `"${data}"`;
    if (type === 'MX') return /^\d+\s/.test(data) ? data : `10 ${data}.`;
    return data;
  };
  const answers = values.map((data) => ({ name: `${name}.`, type: codes[type] ?? 0, TTL: 300, data: wire(data) }));
  return new Response(JSON.stringify({ Status: 0, ...(answers.length ? { Answer: answers } : {}) }), {
    headers: { 'Content-Type': 'application/dns-json' },
  });
}
