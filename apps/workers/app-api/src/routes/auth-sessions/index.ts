/**
 * Auth sessions — /api/auth-sessions. Self-scoped revocation of the caller's
 * Clerk device sessions, powering Settings → Security ("sign out of other
 * devices").
 *
 * NOTE (W3 legacy-worker phase-out): the platform's security page calls
 * /settings/sessions/:id/revoke and /settings/sessions/revoke-all on
 * api-worker, but api-worker never implemented these routes — they 404
 * today. This is a fresh implementation against the Clerk Backend API
 * (session listing stays client-side via Clerk's frontend SDK, matching the
 * existing page):
 *
 *   - POST /:sessionId/revoke — revoke one of the caller's own sessions
 *   - POST /revoke-all        — revoke all the caller's other active
 *                               sessions (the current session is skipped)
 *
 * Permissions: intentionally ungated beyond auth — strictly self-scoped
 * (ownership of every session is verified against Clerk's user_id before
 * revoking; same precedent as /api/me).
 *
 * Entity events: none — Clerk sessions are not a catalog entity type.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLERK_API = 'https://api.clerk.com/v1';

interface ClerkSession {
  id: string;
  user_id: string;
  status: string;
}

function clerkHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** List the caller's active Clerk sessions (handles both response shapes). */
async function listActiveSessions(env: Env, userId: string): Promise<ClerkSession[]> {
  const resp = await fetch(
    `${CLERK_API}/sessions?user_id=${encodeURIComponent(userId)}&status=active&limit=100`,
    { headers: clerkHeaders(env) },
  );
  if (!resp.ok) {
    throw new Error(`Clerk sessions list returned ${resp.status}`);
  }
  const json = (await resp.json()) as ClerkSession[] | { data?: ClerkSession[] };
  return Array.isArray(json) ? json : (json.data ?? []);
}

async function revokeSession(env: Env, sessionId: string): Promise<boolean> {
  const resp = await fetch(`${CLERK_API}/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    headers: clerkHeaders(env),
  });
  return resp.ok;
}

/**
 * POST /revoke-all — revoke every active session of the caller except the
 * one making this request.
 */
app.post('/revoke-all', async (c) => {
  const userId = c.get('userId');
  const currentSessionId = c.get('sessionId');

  try {
    const sessions = await listActiveSessions(c.env, userId);
    const others = sessions.filter((s) => s.id !== currentSessionId);

    let revokedCount = 0;
    let failedCount = 0;

    for (const session of others) {
      const ok = await revokeSession(c.env, session.id);
      if (ok) revokedCount++;
      else failedCount++;
    }

    return success(c, { revokedCount, failedCount });
  } catch (err) {
    console.error('[app-api/auth-sessions] Failed to revoke all sessions:', err);
    return error.internal(c, 'Failed to revoke sessions');
  }
});

/**
 * POST /:sessionId/revoke — revoke a single session after verifying it
 * belongs to the caller.
 */
app.post('/:sessionId/revoke', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');

  try {
    // Ownership check: never revoke another user's session.
    const lookup = await fetch(`${CLERK_API}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: clerkHeaders(c.env),
    });
    if (lookup.status === 404) return error.notFound(c, 'Session', sessionId);
    if (!lookup.ok) {
      console.error(`[app-api/auth-sessions] Clerk session lookup returned ${lookup.status}`);
      return error.internal(c, 'Failed to verify session');
    }
    const session = (await lookup.json()) as ClerkSession;
    if (session.user_id !== userId) {
      return error.forbidden(c, 'You can only revoke your own sessions');
    }

    const ok = await revokeSession(c.env, sessionId);
    if (!ok) return error.internal(c, 'Failed to revoke session');

    return success(c, { revoked: true, sessionId });
  } catch (err) {
    console.error('[app-api/auth-sessions] Failed to revoke session:', err);
    return error.internal(c, 'Failed to revoke session');
  }
});

export const authSessionsRoutes = app;
