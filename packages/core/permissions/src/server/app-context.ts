/**
 * @weldsuite/permissions — request app context
 *
 * Reads the `X-Weld-App` header (sent by the platform per module and by the
 * per-module mobile apps) and stores the canonical app code on the context,
 * where `requirePermission` picks it up to evaluate app-scoped keys.
 *
 * A missing or unknown header leaves the context empty, which makes checks
 * fall back to "allowed in any app". That is deliberate and safe: naming a
 * different app could never unlock more than any-app already allows.
 */

import type { Next } from 'hono';
import { APP_CONTEXT_HEADER, normalizeAppCode } from '../apps';
import { APP_CONTEXT_KEY } from './middleware';

export function appContextMiddleware() {
  return async (c: any, next: Next): Promise<void> => {
    const raw = c.req.header(APP_CONTEXT_HEADER);
    if (raw) {
      const app = normalizeAppCode(raw);
      if (app) {
        c.set(APP_CONTEXT_KEY, app);
      } else {
        console.warn(`[permissions] ignoring unknown ${APP_CONTEXT_HEADER} value "${raw}"`);
      }
    }
    await next();
  };
}

/** The request's canonical app code, or null when it has none. */
export function getAppFromContext(c: any): string | null {
  return c.get(APP_CONTEXT_KEY) ?? null;
}
