/** GitLab payload builders for merge-api's tests (REST v4 and project hooks), on top of `fake-http.ts`. */

export const GITLAB_API = 'gitlab.com/api/v4';

export const GITLAB_PROJECT = {
  id: 55,
  path_with_namespace: 'acme/web',
  visibility: 'private',
  default_branch: 'main',
  web_url: 'https://gitlab.com/acme/web',
  namespace: { full_path: 'acme' },
};

export interface GitlabMrFixture {
  iid: number;
  id?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  source?: string;
  author?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  sha?: string;
  reviewers?: string[];
  description?: string | null;
}

/** A merge request in GitLab's REST shape. */
export function gitlabMr(f: GitlabMrFixture) {
  const state = f.state ?? 'opened';
  return {
    id: f.id ?? 7000 + f.iid,
    iid: f.iid,
    title: f.title ?? `Merge request ${f.iid}`,
    description: f.description ?? null,
    state,
    draft: f.draft ?? false,
    created_at: '2026-10-30T09:00:00.000Z',
    updated_at: f.updatedAt ?? '2026-11-01T10:00:00.000Z',
    merged_at: state === 'merged' ? (f.mergedAt ?? f.updatedAt ?? '2026-11-01T10:00:00.000Z') : null,
    closed_at: state === 'closed' ? (f.updatedAt ?? '2026-11-01T10:00:00.000Z') : null,
    web_url: `https://gitlab.com/acme/web/-/merge_requests/${f.iid}`,
    author: { username: f.author ?? 'Octo-Dev', avatar_url: 'https://gitlab.com/avatar/octo' },
    source_branch: f.source ?? `feature/${f.iid}`,
    target_branch: 'main',
    sha: f.sha ?? `sha${f.iid}`,
    diff_refs: { head_sha: f.sha ?? `sha${f.iid}` },
    reviewers: (f.reviewers ?? []).map((username) => ({ username, avatar_url: null })),
    labels: ['bug'],
    changes_count: '3',
    blocking_discussions_resolved: true,
  };
}

export interface GitlabIssueFixture {
  iid: number;
  id?: number;
  title?: string;
  state?: 'opened' | 'closed';
  description?: string | null;
  labels?: string[];
  assignee?: string | null;
  updatedAt?: string;
}

export function gitlabIssue(f: GitlabIssueFixture) {
  return {
    id: f.id ?? 9000 + f.iid,
    iid: f.iid,
    title: f.title ?? `Issue ${f.iid}`,
    description: f.description ?? '',
    state: f.state ?? 'opened',
    labels: f.labels ?? [],
    assignees: f.assignee ? [{ username: f.assignee }] : [],
    author: { username: 'Octo-Dev', avatar_url: 'https://gitlab.com/avatar/octo' },
    web_url: `https://gitlab.com/acme/web/-/issues/${f.iid}`,
    updated_at: f.updatedAt ?? '2026-11-01T10:00:00.000Z',
  };
}

/** A project hook delivery for a merge request. */
export function gitlabMrHook(
  f: GitlabMrFixture & { action?: string; actor?: string; projectId?: number },
): Record<string, unknown> {
  const mr = gitlabMr(f);
  return {
    object_kind: 'merge_request',
    user: { username: f.actor ?? 'Octo-Dev', avatar_url: 'https://gitlab.com/avatar/octo' },
    project: { id: f.projectId ?? 55, path_with_namespace: 'acme/web' },
    object_attributes: {
      id: mr.id,
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      action: f.action ?? 'update',
      url: mr.web_url,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      draft: mr.draft,
      created_at: '2026-10-30 09:00:00 UTC',
      updated_at: (f.updatedAt ?? '2026-11-01T10:00:00.000Z').replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC'),
      last_commit: { id: mr.sha },
    },
    labels: [{ title: 'bug', color: '#d73a4a' }],
    reviewers: mr.reviewers,
  };
}
