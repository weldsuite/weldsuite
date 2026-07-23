/**
 * POST /api/workflows/generate — AI workflow generation.
 *
 * Turns a plain-English prompt into a workflow draft (trigger + steps) for
 * the client to load into the WeldConnect editor for review. Nothing is
 * persisted — `POST /api/workflows` (existing route, same file's sibling
 * `index.ts`) saves it once the user approves.
 *
 * Wired from `./index.ts` via {@link registerGenerateWorkflowRoute} rather
 * than mounted as its own sub-app, to keep this a single additive route on
 * the existing `/api/workflows` Hono instance.
 *
 * Permission: `tasks:create` — same as the other workflow-authoring routes
 * in this file (POST /, POST /:id/duplicate).
 *
 * Credit metering: identical hard-gate + post-consume posture as
 * `/api/ai/generate` (402 INSUFFICIENT_CREDITS when the wallet is empty).
 */

import { z } from 'zod';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { resolveAiMetering, InsufficientAiCreditsError } from '../../services/ai/billing';
import { generateWorkflowDraft, WorkflowGenerationError } from '../../services/workflow-generation';

export const generateWorkflowSchema = z.object({
  /** Plain-English description of the automation to build. */
  prompt: z.string().min(3).max(2000),
});

export function registerGenerateWorkflowRoute(app: Hono<{ Bindings: Env; Variables: Variables }>): void {
  app.post(
    '/generate',
    requirePermission('tasks:create'),
    zValidator('json', generateWorkflowSchema),
    async (c) => {
      const { prompt } = c.req.valid('json');
      const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

      try {
        const result = await generateWorkflowDraft(c.env, { prompt }, metering);
        return success(c, { workflow: result.workflow, warnings: result.warnings });
      } catch (err) {
        if (err instanceof InsufficientAiCreditsError) {
          return error.insufficientCredits(c, {
            currentBalance: err.currentBalance,
            required: err.required,
            shortfall: err.shortfall,
          });
        }
        if (err instanceof WorkflowGenerationError) {
          return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
        }
        console.error('[app-api/workflows] generate failed:', err);
        return error.internal(c, 'Failed to generate workflow');
      }
    },
  );
}
