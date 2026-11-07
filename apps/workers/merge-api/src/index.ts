/**
 * WeldSuite merge-api: WeldMerge's API worker (pull requests and issues across
 * git providers, design/modules/weldmerge.md).
 *
 * Members work on teams, issues, pull requests, the inbox, releases and
 * git-provider connections under /api/merge (Clerk, `apiAuth()`). Provider
 * events arrive from integration-webhook-worker over the `MergeInternal`
 * entrypoint, WeldConnect actions from workflow-worker and WeldAgent tool calls
 * from agent-api over the same one. The GitHub App's setup redirect is public
 * (`/public/merge/github/setup`, before Clerk: its signed state decides). The
 * prefixes this worker owns are listed in @weldsuite/api-modules and checked by
 * its ownership test.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { MergeGithubEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  MergeAgentToolEnvelope,
  MergeAgentToolResult,
  MergeWorkflowActionEnvelope,
  MergeWorkflowActionResult,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { MergeProviderEventAck, MergeProviderEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from './types';
import { isDigestSweepCron, runDigestSweep } from './cron/digest-sweep';
import accountsRoutes from './routes/accounts';
import accountsOauthRoutes from './routes/accounts/oauth';
import chatSubscriptionsRoutes from './routes/chat-subscriptions';
import commentsRoutes from './routes/comments';
import connectionsRoutes from './routes/connections';
import connectionsGithubInstallRoutes from './routes/connections/github-install';
import connectionsOauthRoutes from './routes/connections/oauth';
import cyclesRoutes from './routes/cycles';
import inboxRoutes from './routes/inbox';
import inboxStateRoutes from './routes/inbox/state';
import internalRoutes from './routes/internal';
import issuesRoutes from './routes/issues';
import issuesExternalRoutes from './routes/issues/external';
import issuesLinksRoutes from './routes/issues/links';
import labelsRoutes from './routes/labels';
import oauthRoutes from './routes/oauth';
import publicGithubSetupRoutes from './routes/public/github-setup';
import pullRequestsRoutes from './routes/pull-requests';
import pullRequestsReviewRoutes from './routes/pull-requests/review';
import recordLinksRoutes from './routes/record-links';
import releasesRoutes from './routes/releases';
import repositoriesRoutes from './routes/repositories';
import repositoriesImportRoutes from './routes/repositories/import';
import teamsRoutes from './routes/teams';

const app = createModuleApi<Env, Variables>({ service: 'merge-api' });

// Public (no Clerk session): the GitHub App's setup redirect, trusted by its signed state.
app.route('/public/merge/github', publicGithubSetupRoutes);

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
app.route('/api/merge/repositories', repositoriesImportRoutes);
app.route('/api/merge/issues', issuesExternalRoutes);
app.route('/api/merge/issues', issuesLinksRoutes);
app.route('/api/merge/inbox', inboxStateRoutes);
app.route('/api/merge/connections', connectionsGithubInstallRoutes);
app.route('/api/merge/connections', connectionsOauthRoutes);
app.route('/api/merge/accounts', accountsOauthRoutes);
app.route('/api/merge/oauth', oauthRoutes);
app.route('/api/merge/pull-requests', pullRequestsReviewRoutes);
app.route('/api/merge/releases', releasesRoutes);
app.route('/api/merge/record-links', recordLinksRoutes);
app.route('/api/merge/chat-subscriptions', chatSubscriptionsRoutes);

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

  /** POSTs `body` to one of the internal routes and returns its `{ data }`. */
  private async call<T>(route: string, body: unknown): Promise<T> {
    const res = await internalApp.fetch(
      new Request(`https://merge-internal/internal/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      this.env,
      this.ctx,
    );
    if (!res.ok) throw new Error(`merge-api ${route} answered ${res.status}`);
    return ((await res.json()) as { data: T }).data;
  }

  /** One verified GitHub webhook, forwarded by integration-webhook-worker. */
  githubEvent(envelope: MergeGithubEventEnvelope): Promise<MergeGithubEventAck> {
    return this.call('github-event', envelope);
  }

  /** One GitLab, Bitbucket or Azure DevOps webhook, forwarded by integration-webhook-worker. */
  providerEvent(envelope: MergeProviderEventEnvelope): Promise<MergeProviderEventAck> {
    return this.call('provider-event', envelope);
  }

  /** A WeldConnect `merge.*` action, forwarded by workflow-worker. */
  workflowAction(envelope: MergeWorkflowActionEnvelope): Promise<MergeWorkflowActionResult> {
    return this.call('workflow-action', envelope);
  }

  /** A WeldAgent WeldMerge tool call, forwarded by agent-api. */
  agentTool(envelope: MergeAgentToolEnvelope): Promise<MergeAgentToolResult> {
    return this.call('agent-tool', envelope);
  }
}

export default {
  fetch: app.fetch,

  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // The WeldChat daily digest (see wrangler.toml).
    if (isDigestSweepCron(event.cron)) {
      ctx.waitUntil(
        runDigestSweep(env).catch((err) => {
          console.error('[MergeDigest] Failed:', err);
        }),
      );
    }
  },
};
