/**
 * AI routes — mounted at /api/forms (Rust twin: rust/modules/forms/src/routes/ai.rs; every route answers 503
 * `ai_unavailable` while AI is not set up, and 402 `INSUFFICIENT_CREDITS` when
 * the workspace wallet is empty; each call is charged, ADR AI-005):
 *
 *   POST /ai/generate                  → a draft form from a description          (forms:create)
 *   POST /ai/suggest-blocks            → more questions for the draft            (forms:update)
 *   GET  /forms/:id/ai/summary         → the cached summary, per question or whole form (form_responses:read)
 *   POST /forms/:id/ai/summary         → make a new one (on demand)                (form_responses:read)
 *
 * The summary is of free-text answers that are not sensitive. Nothing here
 * changes a form: the generated definition goes back to the builder, which
 * creates or saves it through the ordinary form routes.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { InsufficientAiCreditsError, resolveAiMetering } from '@weldsuite/core-domain/ai-billing';
import { createAiSummarySchema, generateFormSchema, suggestBlocksSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, errorResponse } from '../../lib/errors';
import { assertAiAvailable, generateForm, suggestBlocks } from '../../services/ai';
import { createAiSummary, getAiSummary } from '../../services/ai-summary';
import { workspaceCtx } from '../../services/context';
import type { Env, Variables } from '../../types';
import { loadForm, type Ctx } from '../forms/shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** AI failures answered as their envelope; credits as the platform's 402. */
async function guarded(c: Ctx, run: () => Promise<Response>): Promise<Response> {
  try {
    assertAiAvailable(c.env);
    return await run();
  } catch (err) {
    if (err instanceof InsufficientAiCreditsError) {
      return error.insufficientCredits(c, { currentBalance: err.currentBalance, required: err.required, shortfall: err.shortfall });
    }
    if (err instanceof FormsError) return errorResponse(c, err);
    throw err;
  }
}

const metering = (c: Ctx) => resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

app.post('/ai/generate', requirePermission('forms:create'), zValidator('json', generateFormSchema), (c) =>
  guarded(c, async () => success(c, await generateForm(c.env, c.req.valid('json'), await metering(c)))),
);

app.post('/ai/suggest-blocks', requirePermission('forms:update'), zValidator('json', suggestBlocksSchema), (c) =>
  guarded(c, async () => success(c, await suggestBlocks(c.env, c.req.valid('json'), await metering(c)))),
);

const summaryQuery = z.object({ blockId: z.string().max(30).optional() });

app.get('/forms/:id/ai/summary', requirePermission('form_responses:read'), zValidator('query', summaryQuery), (c) =>
  guarded(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, await getAiSummary(workspaceCtx(c), loaded.form.id, c.req.valid('query').blockId ?? null));
  }),
);

app.post('/forms/:id/ai/summary', requirePermission('form_responses:read'), zValidator('json', createAiSummarySchema), (c) =>
  guarded(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    const summary = await createAiSummary(workspaceCtx(c), loaded.form.id, c.req.valid('json').blockId, loaded.userId, await metering(c));
    return success(c, summary);
  }),
);

export default app;
