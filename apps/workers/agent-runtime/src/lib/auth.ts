import type { Context, Next } from 'hono';
import type { Env } from '../env';

/** `internalTrusted` is set only by the `AgentRuntimeInternal` entrypoint. */
type AppEnv = { Bindings: Env; Variables: { internalTrusted?: boolean } };

/**
 * Require Authorization: Bearer <INTERNAL_API_SECRET>, unless the request came
 * through the `AgentRuntimeInternal` entrypoint (service binding only, so
 * trusted by topology). The public bearer path stays until every caller uses
 * the entrypoint (docs/plans/app-api-module-split.md, rollout item 7).
 */
export async function requireInternalAuth(c: Context<AppEnv>, next: Next) {
  if (c.get('internalTrusted') === true) {
    await next();
    return;
  }
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
