/**
 * GitLab's `ConnectionAdapter`: projects, merge requests, approvals, pipelines
 * and hooks over REST v4, for gitlab.com and self-managed hosts.
 *
 * Endpoints (relative to `{host}/api/v4`, `:id` the project id):
 *   GET  /projects?membership=true&min_access_level=40&order_by=last_activity_at&per_page=100&page=N
 *   GET  /projects/:id
 *   GET  /projects/:id/merge_requests?state=opened|merged|closed[&updated_after=ISO]&order_by=updated_at&sort=desc&per_page=100&page=N
 *   GET  /projects/:id/merge_requests/:iid
 *   GET  /projects/:id/merge_requests/:iid/approvals
 *   GET  /projects/:id/pipelines?sha=:sha&order_by=id&sort=desc&per_page=1
 *   POST /projects/:id/hooks, DELETE /projects/:id/hooks/:hookId   (webhooks.ts)
 */

import {
  gitlabChecksStatus,
  gitlabReviewDecision,
  mapGitlabMergeRequest,
  type GitlabApprovals,
  type GitlabMergeRequest,
} from '@weldsuite/merge-domain/providers/gitlab';
import { collectPages, isStatus } from '../provider-http';
import type { ConnectionAdapter, RemoteRepository } from '../types';
import {
  BACKFILL_CAP,
  BACKFILL_DAYS,
  GITLAB_PAGE,
  GITLAB_PAGES,
  gitlabClient,
  projectPath,
  type GitlabProject,
} from './client';
import { gitlabWebhooks } from './webhooks';

function remoteRepository(project: GitlabProject): RemoteRepository {
  return {
    externalId: String(project.id),
    fullName: project.path_with_namespace,
    private: project.visibility !== 'public',
    defaultBranch: project.default_branch ?? null,
    url: project.web_url ?? null,
    externalProject: project.namespace?.full_path ?? null,
  };
}

const mergeRequestsQuery = (state: string, since: Date | null, page: number): string => {
  const updated = since ? `&updated_after=${encodeURIComponent(since.toISOString())}` : '';
  return `merge_requests?state=${state}${updated}&order_by=updated_at&sort=desc&per_page=${GITLAB_PAGE}&page=${page}`;
};

export const gitlabConnection: ConnectionAdapter = {
  ...gitlabWebhooks,

  async listAvailableRepositories(ctx) {
    const client = gitlabClient(ctx);
    const projects = await collectPages<GitlabProject>(
      async (page) => {
        const rows =
          (await client.get<GitlabProject[]>(
            `/projects?membership=true&min_access_level=40&order_by=last_activity_at&per_page=${GITLAB_PAGE}&page=${page}`,
          )) ?? [];
        return { rows, more: rows.length === GITLAB_PAGE };
      },
      GITLAB_PAGES,
      GITLAB_PAGE * GITLAB_PAGES,
    );
    return projects.map(remoteRepository);
  },

  async getRepository(ctx, externalId) {
    const project = await gitlabClient(ctx).get<GitlabProject>(`/projects/${encodeURIComponent(externalId)}`);
    return project ? remoteRepository(project) : null;
  },

  async listPullRequestsForBackfill(ctx, repository, now = new Date()) {
    const client = gitlabClient(ctx);
    const since = new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
    const out: GitlabMergeRequest[] = [];
    const passes: Array<[string, Date | null]> = [
      ['opened', null],
      ['merged', since],
      ['closed', since],
    ];
    for (const [state, from] of passes) {
      const rows = await collectPages<GitlabMergeRequest>(
        async (page) => {
          const list =
            (await client.get<GitlabMergeRequest[]>(`${projectPath(repository)}/${mergeRequestsQuery(state, from, page)}`)) ?? [];
          return { rows: list, more: list.length === GITLAB_PAGE };
        },
        GITLAB_PAGES,
        BACKFILL_CAP - out.length,
      );
      out.push(...rows);
      if (out.length >= BACKFILL_CAP) break;
    }
    return out.map(mapGitlabMergeRequest);
  },

  async getPullRequest(ctx, repository, number) {
    const mr = await gitlabClient(ctx).get<GitlabMergeRequest>(`${projectPath(repository)}/merge_requests/${number}`);
    return mr ? mapGitlabMergeRequest(mr) : null;
  },

  async reviewDecision(ctx, repository, number) {
    const client = gitlabClient(ctx);
    const base = `${projectPath(repository)}/merge_requests/${number}`;
    const mr = await client.get<GitlabMergeRequest>(base);
    if (!mr) return null;
    let approvals: GitlabApprovals | null = null;
    try {
      approvals = await client.get<GitlabApprovals>(`${base}/approvals`);
    } catch (err) {
      // Approvals are not available on every edition and plan: no approvals, not a failure.
      if (!isStatus(err, 403, 405)) throw err;
    }
    const approvers = new Set((approvals?.approved_by ?? []).map((a) => a.user?.username?.toLowerCase()));
    const waiting = (mr.reviewers ?? []).filter((r) => !approvers.has(r.username?.toLowerCase())).length;
    return gitlabReviewDecision({
      approvals,
      blockingDiscussionsResolved: mr.blocking_discussions_resolved,
      requestedReviewerCount: waiting,
    });
  },

  async checksStatus(ctx, repository, headSha) {
    const pipelines =
      (await gitlabClient(ctx).get<Array<{ status?: string }>>(
        `${projectPath(repository)}/pipelines?sha=${encodeURIComponent(headSha)}&order_by=id&sort=desc&per_page=1`,
      )) ?? [];
    return gitlabChecksStatus(pipelines);
  },
};
