/**
 * Agent Billing API Routes — DISABLED
 *
 * AI/agent billing has been removed along with the underlying tables
 * (`agent_packages`, `workspace_agent_purchases`). These endpoints are kept
 * mounted (so existing clients get a clean, typed error instead of a 404)
 * but every handler now short-circuits with 503.
 *
 * Admin-only — see `requireOrgAdmin`.
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../index';
import { clerkJwtAuth, requireOrgAdmin } from '../middleware/auth';

type AgentBillingEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

export const agentBillingRoutes = new Hono<AgentBillingEnv>();

agentBillingRoutes.use('*', clerkJwtAuth());
agentBillingRoutes.use('*', requireOrgAdmin());

function aiUnavailable(c: Context<AgentBillingEnv>) {
  return c.json(
    { error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } },
    503,
  );
}

// ============================================================================
// POST /checkout — buy an agent package (disabled)
// ============================================================================

agentBillingRoutes.post('/checkout', (c) => aiUnavailable(c));

// ============================================================================
// POST /cancel — stop renewing an agent package (disabled)
// ============================================================================

agentBillingRoutes.post('/cancel', (c) => aiUnavailable(c));
