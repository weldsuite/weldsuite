import type { MiddlewareHandler } from 'hono';
import type { ApiKeySession, HonoEnv } from '../lib/api-types';
import type { RateLimitResult, RateLimitConfig } from '../durable-objects/rate-limiter';

/**
 * Rate limits by tier (requests per minute)
 */
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  free: { windowMs: 60000, maxRequests: 60 },
  starter: { windowMs: 60000, maxRequests: 300 },
  professional: { windowMs: 60000, maxRequests: 1000 },
  enterprise: { windowMs: 60000, maxRequests: 5000 },
};

function getRateLimitConfig(tier: string): RateLimitConfig {
  return RATE_LIMITS[tier] ?? RATE_LIMITS.free!;
}

/**
 * Hono middleware for distributed rate limiting using Durable Objects
 * Must run after auth middleware
 */
export const rateLimitMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession') as ApiKeySession | undefined;

  if (!session) {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Rate limit middleware requires authentication' }, id: null },
      500,
    );
  }

  const config = getRateLimitConfig(session.tier);
  const rateLimiterId = c.env.RATE_LIMITER.idFromName(`mcp:${session.workspaceId}`);
  const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);
  const result = (await rateLimiter.checkLimit(config)) as RateLimitResult;

  if (!result.allowed) {
    const retryAfterSeconds = Math.ceil((result.resetAt - Date.now()) / 1000);

    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32429,
          message: `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
          data: { retryAfter: retryAfterSeconds },
        },
        id: null,
      },
      429,
      {
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': Math.ceil(result.resetAt / 1000).toString(),
        'Retry-After': retryAfterSeconds.toString(),
      },
    );
  }

  await next();
};
