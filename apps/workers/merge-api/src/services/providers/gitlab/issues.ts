/**
 * GitLab's `IssueSyncAdapter` (two-way issue sync, area A's engine in
 * `services/issue-sync/`). Issues are `iid`-numbered inside a project;
 * `repository.externalId` is the project id. GitLab has no close reason, so
 * `stateReason` is always null; an assignee is set by login through a user
 * lookup; labels are plain names GitLab creates on first use.
 *
 * Endpoints (relative to `{host}/api/v4`):
 *   GET  /projects/:id/issues?state=opened|closed|all[&updated_after=ISO]&order_by=updated_at&sort=desc&per_page=100&page=N
 *   GET  /projects/:id/issues/:iid
 *   POST /projects/:id/issues            {title, description, labels, assignee_ids}
 *   PUT  /projects/:id/issues/:iid       {title, description, labels, assignee_ids, state_event}
 *   GET  /users?username=:login
 *   GET  /projects/:id/issues/:iid/notes?sort=asc&order_by=created_at&per_page=100&page=N
 *   POST /projects/:id/issues/:iid/notes {body}
 */

import {
  mapGitlabIssue,
  mapGitlabNote,
  type GitlabIssue,
  type GitlabNote,
} from '@weldsuite/merge-domain/providers/gitlab';
import { collectPages, type ApiClient } from '../provider-http';
import type { IssueSyncAdapter, IssueWriteInput } from '../types';
import { GITLAB_PAGE, GITLAB_PAGES, gitlabClient, projectPath } from './client';

const issuePath = (repository: { externalId: string }, number: number) => `${projectPath(repository)}/issues/${number}`;

/** The user id of a login, or null when GitLab has no such user. */
async function userId(client: ApiClient, login: string): Promise<number | null> {
  const users = (await client.get<Array<{ id: number }>>(`/users?username=${encodeURIComponent(login)}`)) ?? [];
  return users[0]?.id ?? null;
}

/** The request body for the fields set in `input`; an unknown assignee login leaves the assignee unset. */
async function writeBody(client: ApiClient, input: IssueWriteInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.body !== undefined) body.description = input.body;
  if (input.labels !== undefined) body.labels = input.labels.join(',');
  if (input.state !== undefined) body.state_event = input.state === 'closed' ? 'close' : 'reopen';
  if (input.assigneeLogin === null) {
    body.assignee_ids = [];
  } else if (input.assigneeLogin !== undefined) {
    const id = await userId(client, input.assigneeLogin);
    if (id !== null) body.assignee_ids = [id];
  }
  return body;
}

export const gitlabIssues: IssueSyncAdapter = {
  async listIssues(ctx, repository, options = {}) {
    const client = gitlabClient(ctx);
    const state = options.state === 'open' ? 'opened' : (options.state ?? 'all');
    const since = options.since ? `&updated_after=${encodeURIComponent(options.since.toISOString())}` : '';
    const cap = options.limit ?? GITLAB_PAGE * GITLAB_PAGES;
    const rows = await collectPages<GitlabIssue>(
      async (page) => {
        const list =
          (await client.get<GitlabIssue[]>(
            `${projectPath(repository)}/issues?state=${state}${since}&order_by=updated_at&sort=desc&per_page=${GITLAB_PAGE}&page=${page}`,
          )) ?? [];
        return { rows: list, more: list.length === GITLAB_PAGE };
      },
      Math.ceil(cap / GITLAB_PAGE),
      cap,
    );
    return rows.map(mapGitlabIssue);
  },

  async getIssue(ctx, repository, number) {
    const issue = await gitlabClient(ctx).get<GitlabIssue>(issuePath(repository, number));
    return issue ? mapGitlabIssue(issue) : null;
  },

  async createIssue(ctx, repository, input) {
    const client = gitlabClient(ctx);
    const { state, ...fields } = input;
    const created = await client.send<GitlabIssue>('POST', `${projectPath(repository)}/issues`, await writeBody(client, fields));
    if (!created) throw new Error('GitLab answered an issue create with an empty body');
    if (state !== 'closed') return mapGitlabIssue(created);
    const closed = await client.send<GitlabIssue>('PUT', issuePath(repository, created.iid), { state_event: 'close' });
    return mapGitlabIssue(closed ?? created);
  },

  async updateIssue(ctx, repository, number, input) {
    const client = gitlabClient(ctx);
    const updated = await client.send<GitlabIssue>('PUT', issuePath(repository, number), await writeBody(client, input));
    if (!updated) throw new Error('GitLab answered an issue update with an empty body');
    return mapGitlabIssue(updated);
  },

  async listComments(ctx, repository, number) {
    const client = gitlabClient(ctx);
    const notes = await collectPages<GitlabNote>(
      async (page) => {
        const list =
          (await client.get<GitlabNote[]>(
            `${issuePath(repository, number)}/notes?sort=asc&order_by=created_at&per_page=${GITLAB_PAGE}&page=${page}`,
          )) ?? [];
        return { rows: list, more: list.length === GITLAB_PAGE };
      },
      GITLAB_PAGES,
      GITLAB_PAGE * GITLAB_PAGES,
    );
    return notes.filter((n) => n.system !== true).map((n) => mapGitlabNote(n, number));
  },

  async createComment(ctx, repository, number, body) {
    const note = await gitlabClient(ctx).send<GitlabNote>('POST', `${issuePath(repository, number)}/notes`, { body });
    if (!note) throw new Error('GitLab answered a note create with an empty body');
    return mapGitlabNote(note, number);
  },
};
