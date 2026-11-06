/**
 * POST /workflow-action: a WeldConnect `merge.*` action, forwarded by
 * workflow-worker (`MergeInternal.workflowAction()`).
 *
 * The action runs AS THE WORKFLOW'S OWNER (`envelope.userId`, CONN-004): their
 * WeldMerge permissions are resolved now, so a workflow cannot do what its
 * owner no longer may. It uses the same issue services as the member routes and
 * publishes the same entity events, with the run's chain depth so a workflow
 * triggered by `merge_issue.created` cannot create issues forever.
 *
 *   merge.create_issue      merge_issues:create   { teamId, title, description?, status?, priority?, assigneeUserId?, ... }
 *   merge.update_issue      merge_issues:update   { issue (id or key), ...any issue field }
 *   merge.comment_on_issue  merge_issues:update   { issue (id or key), body }
 *
 * Answers `{ ok, issueId, issueKey, commentId, error }` (never an error status
 * for a refusal: workflow-worker turns `ok: false` into a failed step).
 * Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { success } from '@weldsuite/worker-kit/response';
import {
  mergeWorkflowActionEnvelopeSchema,
  mergeWorkflowActionInputSchemas,
  type MergeWorkflowAction,
  type MergeWorkflowActionResult,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';
import type { Ctx } from '../shared';
import { authorizeMember, MemberForbiddenError, resolveInternalWorkspace } from '../../services/across-access';
import { commentOnIssueAs, createIssueAs, describeIssues, updateIssueAs, type Actor } from '../../services/across-issues';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const PERMISSIONS: Record<MergeWorkflowAction, { key: string; doing: string }> = {
  'merge.create_issue': { key: 'merge_issues:create', doing: 'create issues' },
  'merge.update_issue': { key: 'merge_issues:update', doing: 'change issues' },
  'merge.comment_on_issue': { key: 'merge_issues:update', doing: 'comment on issues' },
};

const result = (patch: Partial<MergeWorkflowActionResult>): MergeWorkflowActionResult => ({
  ok: false,
  issueId: null,
  issueKey: null,
  commentId: null,
  error: null,
  ...patch,
});

/**
 * A workflow node resolves its fields to text: blank fields mean "not set",
 * numbers arrive as numeric strings and lists as comma-separated ones.
 */
export function workflowInput(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  for (const key of ['priority', 'estimate'] as const) {
    const value = out[key];
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) out[key] = Number(value.trim());
  }
  if (typeof out.labelIds === 'string') {
    out.labelIds = out.labelIds.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

async function run(c: Ctx, actor: Actor, action: MergeWorkflowAction, raw: Record<string, unknown>): Promise<MergeWorkflowActionResult> {
  const input = workflowInput(raw);
  switch (action) {
    case 'merge.create_issue': {
      const parsed = mergeWorkflowActionInputSchemas['merge.create_issue'].safeParse(input);
      if (!parsed.success) return result({ error: describeIssues(parsed.error.issues) });
      const outcome = await createIssueAs(c, actor, parsed.data);
      return outcome.ok ? result({ ok: true, issueId: outcome.issue.id, issueKey: outcome.issue.key }) : result({ error: outcome.message });
    }
    case 'merge.update_issue': {
      const parsed = mergeWorkflowActionInputSchemas['merge.update_issue'].safeParse(input);
      if (!parsed.success) return result({ error: describeIssues(parsed.error.issues) });
      const { issue, ...patch } = parsed.data;
      const outcome = await updateIssueAs(c, actor, issue, patch);
      return outcome.ok ? result({ ok: true, issueId: outcome.issue.id, issueKey: outcome.issue.key }) : result({ error: outcome.message });
    }
    case 'merge.comment_on_issue': {
      const parsed = mergeWorkflowActionInputSchemas['merge.comment_on_issue'].safeParse(input);
      if (!parsed.success) return result({ error: describeIssues(parsed.error.issues) });
      const outcome = await commentOnIssueAs(c, actor, parsed.data.issue, parsed.data.body);
      return outcome.ok
        ? result({ ok: true, issueId: outcome.issue.id, issueKey: `${outcome.teamKey}-${outcome.issue.number}`, commentId: outcome.comment.id })
        : result({ error: outcome.message });
    }
  }
}

app.post('/workflow-action', zValidator('json', mergeWorkflowActionEnvelopeSchema), async (c) => {
  const envelope = c.req.valid('json');
  const db = await resolveInternalWorkspace(c, envelope.workspaceId, envelope.userId);
  if (!db) return success(c, result({ error: `Workspace ${envelope.workspaceId} was not found or is suspended` }));

  const permission = PERMISSIONS[envelope.action];
  try {
    await authorizeMember(db, c.env, envelope.userId, permission.key, permission.doing);
  } catch (err) {
    if (err instanceof MemberForbiddenError) return success(c, result({ error: err.message }));
    throw err;
  }
  const actor: Actor = { userId: envelope.userId, workflowDepth: envelope.chainDepth ?? 0 };
  return success(c, await run(c, actor, envelope.action, envelope.input));
});

export default app;
