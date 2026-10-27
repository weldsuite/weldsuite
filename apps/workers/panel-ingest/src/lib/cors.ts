import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';

/**
 * The collector answers any site: the project token and its allowed domains
 * decide what is accepted (routes/events.ts), not CORS. The request's own
 * Origin is echoed back (`*` without one), never with credentials, so
 * nothing here can carry a cookie.
 */
export const cors = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const origin = c.req.header('Origin') || undefined;
  c.header('Access-Control-Allow-Origin', origin ?? '*');
  if (origin) c.header('Vary', 'Origin');

  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '86400');
    return c.body(null, 204);
  }
  await next();
});
