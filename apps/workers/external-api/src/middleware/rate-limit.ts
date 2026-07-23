import type { MiddlewareHandler } from 'hono';
import type { HonoEnv, Env } from '../types';
import { error } from '../lib/response';

/**
 * Per-tier rate limit metadata. The actual enforcement (counter + window) is
 * owned by Cloudflare's native rate-limiting binding — one namespace per tier,
 * declared in `wrangler.toml`. The `limit`/`period` values here MUST mirror the
 * `[ratelimits.simple]` config of the corresponding binding; they are used only
 * to populate the informational `X-RateLimit-Limit` / `Retry-After` headers.
 */
interface TierRateLimit {
  /** Binding name on `Env` for this tier's native rate limiter. */
  binding: keyof Pick<Env, 'RL_FREE' | 'RL_BUSINESS' | 'RL_SCALE' | 'RL_ENTERPRISE'>;
  /** Requests allowed per `periodSeconds` — mirrors the wrangler config. */
  limit: number;
  /** Window length in seconds — mirrors the wrangler config (10 or 60). */
  periodSeconds: number;
}

/**
 * Rate limits by tier (requests per minute). Keep in sync with the
 * `[[ratelimits]]` blocks in `apps/workers/external-api/wrangler.toml`.
 */
export const RATE_LIMITS: Record<string, TierRateLimit> = {
  free: { binding: 'RL_FREE', limit: 60, periodSeconds: 60 },
  business: { binding: 'RL_BUSINESS', limit: 300, periodSeconds: 60 },
  scale: { binding: 'RL_SCALE', limit: 1_000, periodSeconds: 60 },
  enterprise: { binding: 'RL_ENTERPRISE', limit: 5_000, periodSeconds: 60 },
};

export function getTierRateLimit(tier: string): TierRateLimit {
  return RATE_LIMITS[tier] ?? RATE_LIMITS.free!;
}

/**
 * Rate limiting middleware backed by Cloudflare's native rate-limit binding.
 * Must run after `authMiddleware`. Selects the per-tier namespace, keys the
 * limiter by `workspaceId`, sets `X-RateLimit-Limit`, and returns 429 with
 * `Retry-After` when the workspace exceeds its tier limit.
 *
 * Note: the native binding is per-Cloudflare-location and eventually
 * consistent — counters are not globally exact, so the limit is enforced
 * permissively by design.
 */
export const rateLimitMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession');
  if (!session) return error.unauthorized(c);

  const { binding, limit, periodSeconds } = getTierRateLimit(session.tier);
  const limiter = c.env[binding];

  c.header('X-RateLimit-Limit', String(limit));

  const { success } = await limiter.limit({ key: session.workspaceId });

  if (!success) {
    return error.rateLimited(c, 'Too many requests. Please try again later.', periodSeconds);
  }

  await next();
};
