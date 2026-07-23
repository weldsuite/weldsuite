/**
 * AI models route — /api/ai-models/* — STUBBED.
 *
 * AI has been physically removed from WeldSuite. `GET /models` used to list
 * active AI models with pricing/credit info from the master `ai_model_rates`
 * table (or a hardcoded fallback list) for model-picker UIs; since there is
 * no AI to pick a model for anymore, it now always returns a 503.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /models — AI is currently unavailable.
 */
app.get('/models', async (c) => {
  return c.json({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } }, 503);
});

export const aiModelsRoutes = app;
