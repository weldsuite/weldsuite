/**
 * Small HTTP helpers the panel routes share (kept out of `services/`, which
 * have no Hono context).
 */

import type { Context } from 'hono';
import { InsufficientAiCreditsError } from '@weldsuite/core-domain/ai-billing';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error } from '@weldsuite/worker-kit/response';
import { PanelQueryError } from '@weldsuite/panel-domain/query';
import { AiDisabledError, NoSessionsError, PanelAiError } from './services/ai-summaries';
import type { ProjectRegistry } from './services/project-registry';
import { QueryUnavailableError } from './services/query-engine';
import type { Env, Variables } from './types';

export type PanelContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * What the collector's copy of a project needs (master DB, the shared KV
 * namespace and `workspaces.id`). Null without a workspace.
 */
export function registryFor(c: PanelContext): ProjectRegistry | null {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return null;
  return { masterDb: getMasterDb(c.env), kv: c.env.WORKSPACE_CACHE, workspaceId };
}

/** The answer for a failed query: 400 for a spec the compiler refuses, 503 when not configured, else 502. */
export function queryFailure(c: PanelContext, err: unknown): Response {
  if (err instanceof PanelQueryError) return error.badRequest(c, err.message);
  if (err instanceof QueryUnavailableError) return error.unavailable(c, err.message);
  console.error('[panel-api] query failed', err);
  return error.badGateway(c, 'The analytics store did not answer');
}

/**
 * What a failed AI call answers: 402 when the wallet cannot pay (details name
 * the credits needed and available), 403 when the project switched AI off, 404
 * for a filter that matches nothing, the AI error's own status, else as a query failure.
 */
export function aiFailure(c: PanelContext, err: unknown): Response {
  if (err instanceof InsufficientAiCreditsError) {
    return error.paymentRequired(c, 'INSUFFICIENT_CREDITS', 'Insufficient credits. Top up your workspace balance to continue.', {
      requiredCredits: err.required,
      availableCredits: err.currentBalance,
    });
  }
  if (err instanceof AiDisabledError) return c.json({ error: { code: 'AI_DISABLED', message: err.message } }, 403);
  if (err instanceof NoSessionsError) return c.json({ error: { code: 'NO_SESSIONS', message: err.message } }, 404);
  if (err instanceof PanelAiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  return queryFailure(c, err);
}
