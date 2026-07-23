import { createMiddleware } from 'hono/factory';
import { createClerkClient } from '@clerk/backend';
import type { Env } from '../index';

const VERIFY_CACHE_TTL_SECONDS = 300; // 5 minutes

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const m2mAuth = () => {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    console.log('[M2M Auth] Authorization header present:', !!authHeader);

    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[M2M Auth] Missing or invalid Authorization header');
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    console.log('[M2M Auth] Token length:', token.length, 'starts with:', token.substring(0, 10));

    const cacheKey = `m2m:verified:${await hashToken(token)}`;

    // Check KV cache
    const cached = await c.env.WORKSPACE_CACHE.get(cacheKey);
    if (cached) {
      console.log('[M2M Auth] Cache hit');
      await next();
      return;
    }

    console.log('[M2M Auth] Cache miss, verifying with Clerk...');
    console.log('[M2M Auth] CLERK_SECRET_KEY present:', !!c.env.CLERK_SECRET_KEY);
    console.log('[M2M Auth] CLERK_MACHINE_SECRET_KEY present:', !!c.env.CLERK_MACHINE_SECRET_KEY);

    try {
      const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
      await clerk.m2m.verifyToken({
        token,
        machineSecretKey: c.env.CLERK_MACHINE_SECRET_KEY,
      });

      console.log('[M2M Auth] Token verified successfully');

      // Cache in KV with auto-expiry
      c.executionCtx.waitUntil(
        c.env.WORKSPACE_CACHE.put(cacheKey, '1', { expirationTtl: VERIFY_CACHE_TTL_SECONDS })
      );

      await next();
    } catch (error) {
      console.error('[M2M Auth] Token verification failed:', error instanceof Error ? error.message : error);
      return c.json({ error: 'Unauthorized' }, 401);
    }
  });
};
