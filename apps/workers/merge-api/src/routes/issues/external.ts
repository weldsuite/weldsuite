/**
 * Issue to provider issue links: /api/merge/issues/:id/external.
 *
 *   POST   /:id/external {repositoryId} -> creates the issue on the repository's provider (GitHub, GitLab)
 *                                          with its title, description, labels, assignee and open/closed
 *                                          state, and links it                       (merge_issues:update)
 *   DELETE /:id/external                -> stops syncing; the provider issue stays (merge_issues:update)
 *
 * Both run the provider call inside the request. A refusal is 502
 * `provider_error` (the provider's message), a provider without issues 422, an
 * issue already linked 409, an unknown repository 404. Each publishes
 * `merge_issue` updated with the `external` change.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { createMergeExternalIssueSchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { unprocessable, type Ctx } from '../shared';
import { syncFailure } from './sync-failure';
import { publishEntityEvents } from '../../services/events';
import { createExternalIssue, removeExternalIssue } from '../../services/issue-sync/outbound';
import { findIssue } from '../../services/issues';
import { issueEventData } from '../../services/mappers';
import type { MergeIssueRow } from '../../services/db';
import { findTeam } from '../../services/teams';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function publishExternalChange(c: Ctx, issue: MergeIssueRow, change: { old: unknown; new: unknown }) {
  const team = await findTeam(c.get('tenantDb'), issue.teamId);
  publishEntityEvents(c, [
    {
      entityType: 'merge_issue',
      action: 'updated',
      entityId: issue.id,
      data: issueEventData(issue, team?.key ?? ''),
      changes: { external: change },
    },
  ]);
}

app.post('/:id/external', requirePermission('merge_issues:update'), zValidator('json', createMergeExternalIssueSchema), async (c) => {
  const id = c.req.param('id');
  const { repositoryId } = c.req.valid('json');
  const db = c.get('tenantDb');
  const issue = await findIssue(db, id);
  if (!issue) return error.notFound(c, 'Issue', id);

  try {
    const result = await createExternalIssue(db, c.env, issue, repositoryId);
    if (!result.ok) {
      if (result.reason === 'already_linked') return error.conflict(c, 'The issue is already linked to a provider issue');
      if (result.reason === 'unsupported') return unprocessable(c, 'This provider does not support issue sync');
      return error.notFound(c, 'Repository', repositoryId);
    }
    const { link, repositoryFullName } = result;
    await publishExternalChange(c, issue, { old: null, new: { provider: link.provider, number: link.number } });
    return success(
      c,
      {
        provider: link.provider,
        number: link.number,
        url: link.url,
        state: link.state,
        repositoryId: link.repositoryId,
        repositoryFullName,
      },
      201,
    );
  } catch (err) {
    const response = syncFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.delete('/:id/external', requirePermission('merge_issues:update'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const issue = await findIssue(db, id);
  if (!issue) return error.notFound(c, 'Issue', id);
  if (!(await removeExternalIssue(db, id))) return error.notFound(c, 'External issue', id);
  await publishExternalChange(c, issue, { old: { linked: true }, new: null });
  return noContent(c);
});

export default app;
