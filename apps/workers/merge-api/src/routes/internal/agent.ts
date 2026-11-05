/**
 * POST /agent-tool: a WeldAgent WeldMerge tool call, forwarded by agent-api
 * (`MergeInternal.agentTool()`).
 *
 * Foundation stub (area E): answers a failed result until the handler is built.
 * The tools are `MERGE_AGENT_TOOLS`; the handler permission-checks as the
 * agent's acting member and reuses the issue and pull request services.
 * Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { success } from '@weldsuite/worker-kit/response';
import { mergeAgentToolEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/agent-tool', zValidator('json', mergeAgentToolEnvelopeSchema), async (c) => {
  return success(c, { ok: false, result: null, error: 'not_implemented' });
});

export default app;
