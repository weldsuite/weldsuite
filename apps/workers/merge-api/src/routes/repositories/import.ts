/**
 * Issue import: /api/merge/repositories/:id/import-issues.
 *
 *   POST /:id/import-issues -> reads the repository's open provider issues (up to 500) and creates a
 *                              WeldMerge issue in the repository's team for each one it does not know yet,
 *                              refreshing the known ones; answers { imported, updated, skipped }
 *
 * Permission: merge_connections:manage. The repository needs a team and
 * `issue_sync` `import` or `two_way`, on a provider that has issues (422
 * otherwise). Provider comments are not read here: they arrive with the
 * `issue_comment` events. The provider reads run inside the request; a
 * provider refusing is 502 `provider_error`.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { MERGE_IMPORT_ISSUES_LIMIT } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { unprocessable } from '../shared';
import { syncFailure } from '../issues/sync-failure';
import { publishEntityEvents } from '../../services/events';
import { importProviderIssues } from '../../services/issue-sync/inbound';
import { adapterContext, loadTarget, repositoryRef } from '../../services/issue-sync/targets';
import { providerModule } from '../../services/providers/registry';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id/import-issues', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const target = await loadTarget(db, id);
  if (!target) return error.notFound(c, 'Repository', id);

  const { repository } = target;
  const adapter = providerModule(repository.provider).issues;
  if (!adapter) return unprocessable(c, `${repository.provider} does not support issue sync`);
  if (repository.issueSync === 'off') return unprocessable(c, 'Turn issue sync on for this repository first');
  if (!repository.teamId) return unprocessable(c, 'Give this repository a team first: imported issues belong to it');

  try {
    const issues = await adapter.listIssues(await adapterContext(db, c.env, target), repositoryRef(repository), {
      state: 'open',
      limit: MERGE_IMPORT_ISSUES_LIMIT,
    });
    const { counts, events } = await importProviderIssues({ db, target, userId: c.get('userId') }, issues);
    publishEntityEvents(c, events);
    return success(c, counts);
  } catch (err) {
    const response = syncFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
