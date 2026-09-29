/**
 * Best-effort chat rate limiter backed by WORKSPACE_CACHE (KV).
 * Falls open when KV is unavailable so local/dev keeps working.
 */

import type { Env } from '../../types';

const WINDOW_MS = 60_000;

export async function consumeChatRateLimit(
  env: Env,
  key: string,
  max: number,
): Promise<{ ok: boolean; remaining: number }> {
  const kv = env.WORKSPACE_CACHE;
  if (!kv?.get || !kv?.put) return { ok: true, remaining: max };

  const storageKey = `chat:rl:${key}`;
  try {
    const raw = await kv.get(storageKey, 'json');
    const state = (raw && typeof raw === 'object' ? raw : null) as {
      count?: number;
      resetAt?: number;
    } | null;
    const now = Date.now();
    let count = typeof state?.count === 'number' ? state.count : 0;
    let resetAt = typeof state?.resetAt === 'number' ? state.resetAt : now + WINDOW_MS;

    if (now >= resetAt) {
      count = 0;
      resetAt = now + WINDOW_MS;
    }

    if (count >= max) {
      return { ok: false, remaining: 0 };
    }

    count += 1;
    const ttlSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    await kv.put(storageKey, JSON.stringify({ count, resetAt }), { expirationTtl: ttlSeconds });
    return { ok: true, remaining: Math.max(0, max - count) };
  } catch (err) {
    console.error('[chat-rate-limit] failed, allowing request:', err);
    return { ok: true, remaining: max };
  }
}
