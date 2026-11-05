/**
 * POST /workflow-action: a WeldConnect `merge.*` action, forwarded by
 * workflow-worker (`MergeInternal.workflowAction()`).
 *
 * Foundation stub (area E): answers a failed result until the handler is built.
 * The handler resolves the workspace like `github-event`, permission-checks as
 * the workflow owner (`envelope.userId`, CONN-004), runs the issue service
 * (create / update / comment) and publishes the same entity events the member
 * routes do. Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { success } from '@weldsuite/worker-kit/response';
import { mergeWorkflowActionEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/workflow-action', zValidator('json', mergeWorkflowActionEnvelopeSchema), async (c) => {
  return success(c, { ok: false, issueId: null, issueKey: null, commentId: null, error: 'not_implemented' });
});

export default app;
