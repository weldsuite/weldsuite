import type { Context, Next } from 'hono';
import type { Env } from '../env';

type AppEnv = { Bindings: Env };

/** Require Authorization: Bearer <INTERNAL_API_SECRET>. */
export async function requireInternalAuth(c: Context<AppEnv>, next: Next) {
  const secret = c.env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    return c.json({ error: 'INTERNAL_API_SECRET is not configured' }, 503);
  }
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token !== secret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}

export function computerEnabled(env: Env): boolean {
  return (env.AGENT_COMPUTER_ENABLED ?? 'true').toLowerCase() !== 'false';
}
