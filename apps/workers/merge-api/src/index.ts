/**
 * WeldSuite merge-api: WeldMerge's API worker (pull requests and issues across
 * git providers, design/modules/weldmerge.md).
 *
 * Members work on teams, issues, pull requests, the inbox and git-provider
 * connections under /api/merge (Clerk, `apiAuth()`). GitHub events arrive from
 * integration-webhook-worker over the `MergeInternal` entrypoint. The prefixes
 * this worker owns are listed in @weldsuite/api-modules and checked by its
 * ownership test.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { MergeGithubEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from './types';
import accountsRoutes from './routes/accounts';
import commentsRoutes from './routes/comments';
import connectionsRoutes from './routes/connections';
import cyclesRoutes from './routes/cycles';
import inboxRoutes from './routes/inbox';
import internalRoutes from './routes/internal';
import issuesRoutes from './routes/issues';
import labelsRoutes from './routes/labels';
import pullRequestsRoutes from './routes/pull-requests';
import repositoriesRoutes from './routes/repositories';
import teamsRoutes from './routes/teams';

const app = createModuleApi<Env, Variables>({ service: 'merge-api' });

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).
app.route('/api/merge/teams', teamsRoutes);
app.route('/api/merge/labels', labelsRoutes);
app.route('/api/merge/cycles', cyclesRoutes);
app.route('/api/merge/issues', issuesRoutes);
app.route('/api/merge/comments', commentsRoutes);
app.route('/api/merge/pull-requests', pullRequestsRoutes);
app.route('/api/merge/inbox', inboxRoutes);
app.route('/api/merge/accounts', accountsRoutes);
app.route('/api/merge/connections', connectionsRoutes);
app.route('/api/merge/repositories', repositoriesRoutes);

// Internal entrypoint, bound as MERGE_INTERNAL (entrypoint = "MergeInternal") by
// integration-webhook-worker. A named entrypoint is only reachable over a
// service binding, so it is trusted by topology (ADR API-008). Only the internal
// router is mounted here; the public app above never serves it.
const internalApp = createModuleApi<Env, Variables>({ service: 'merge-api' });
internalApp.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
internalApp.route('/internal', internalRoutes);

/** What `MergeInternal.githubEvent` answers. */
export interface MergeGithubEventAck {
  outcome: 'applied' | 'ignored';
  reason?: string;
}

export class MergeInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }

  /** One verified GitHub webhook, forwarded by integration-webhook-worker. */
  async githubEvent(envelope: MergeGithubEventEnvelope): Promise<MergeGithubEventAck> {
    const res = await internalApp.fetch(
      new Request('https://merge-internal/internal/github-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      }),
      this.env,
      this.ctx,
    );
    if (!res.ok) throw new Error(`merge-api github-event answered ${res.status}`);
    return ((await res.json()) as { data: MergeGithubEventAck }).data;
  }
}

export default {
  fetch: app.fetch,
};
