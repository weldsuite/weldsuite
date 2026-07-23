/**
 * Simple KV-backed rate limiting middleware.
 *
 * Uses Cloudflare KV with short TTL to count requests per IP per minute.
 * GET endpoints get a higher limit than mutating endpoints.
 */

import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../index';

const GET_LIMIT = 120;   // requests per minute for GET
const WRITE_LIMIT = 30;  // requests per minute for POST/PUT/PATCH/DELETE

export function rateLimitMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const kv = c.env.WORKSPACE_CACHE;
    if (!kv) return next(); // KV not configured (local dev)

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const method = c.req.method.toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const limit = isRead ? GET_LIMIT : WRITE_LIMIT;

    const minute = Math.floor(Date.now() / 60_000);
    const key = `rl:${ip}:${isRead ? 'r' : 'w'}:${minute}`;

    try {
      const current = await kv.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= limit) {
        return c.json(
          { error: 'Too many requests', retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60) },
          { status: 429, headers: { 'Retry-After': String(60 - (Math.floor(Date.now() / 1000) % 60)) } },
        );
      }

      // Increment counter (fire-and-forget, don't block the request)
      c.executionCtx.waitUntil(
        kv.put(key, String(count + 1), { expirationTtl: 120 }),
      );
    } catch {
      // KV error — don't block the request
    }

    return next();
  });
}
