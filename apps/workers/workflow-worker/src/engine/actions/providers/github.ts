/**
 * GitHub outbound actions (`github.create_issue`, `github.create_comment`).
 *
 * Auth is `app_installation` (see `@weldsuite/workflow-integrations`'
 * `AppInstallationConfig`): the connection reuses WeldFlow's existing GitHub
 * App installation (one per workspace, `github_connections`) instead of a
 * second OAuth app or a Personal Access Token — `getValidIntegrationToken`
 * (./token.ts) mints a fresh ~1h installation token on every call via
 * `@weldsuite/connect-domain/github/app-auth`. See "Provider pattern" in
 * docs/plans/weldconnect.md.
 */

import type { ActionHandler } from '../../types';
import { NonRetryableStepError } from '../../errors';
import { getValidIntegrationToken } from './token';

/** A retryable failure that keeps the provider's raw payload for the step row. */
class RetryableProviderError extends Error {
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'RetryableProviderError';
    this.details = details;
  }
}

interface GithubErrorBody {
  message?: string;
  errors?: unknown;
}

function ghHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'WeldSuite-WeldConnect',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** `owner/repo` → `{ owner, name }`, or `undefined` if malformed. */
function parseRepo(raw: string): { owner: string; name: string } | undefined {
  const parts = raw.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { owner: parts[0], name: parts[1] };
}

/** `"bug, needs-triage"` → `["bug", "needs-triage"]`; `undefined` when blank
 *  (so it's omitted from the request body rather than sent as `[]`). */
function parseList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Classify a failed GitHub REST response and throw accordingly. Rate-limiting
 * (403 with `x-ratelimit-remaining: 0`) and anything unmapped (5xx, odd 4xx)
 * are retryable — the step's own retry policy decides whether to try again.
 * Bad/revoked auth, missing permissions, not-found, disabled issues and
 * validation failures are not: retrying the exact same request changes
 * nothing. https://docs.github.com/en/rest/overview/troubleshooting
 */
async function mapGithubError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as GithubErrorBody;
  const message = body.message || `GitHub API error (${res.status})`;

  if (res.status === 401) {
    throw new NonRetryableStepError(
      "The GitHub connection is no longer valid — the App installation may have been suspended or revoked. Reconnect it from WeldConnect → Integrations.",
      body,
    );
  }

  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const resetAt = Number(res.headers.get('x-ratelimit-reset'));
      const retryAfterSeconds = Number.isFinite(resetAt)
        ? Math.max(0, resetAt - Math.floor(Date.now() / 1000))
        : undefined;
      throw new RetryableProviderError(
        `GitHub API rate limit exceeded${retryAfterSeconds !== undefined ? ` — retry after ${retryAfterSeconds}s` : ''}`,
        { ...body, retryAfterSeconds },
      );
    }
    throw new NonRetryableStepError(
      `GitHub refused this request: ${message} — the installation may not have permission for this repository.`,
      body,
    );
  }

  if (res.status === 404) {
    throw new NonRetryableStepError(`GitHub repository or issue not found: ${message}`, body);
  }

  if (res.status === 410) {
    throw new NonRetryableStepError(`Issues are disabled on this repository: ${message}`, body);
  }

  if (res.status === 422) {
    throw new NonRetryableStepError(`GitHub rejected this request: ${message}`, body);
  }

  // Unmapped 4xx/5xx — treat as an unexpected provider hiccup, retryable.
  throw new RetryableProviderError(`GitHub API error (${res.status}): ${message}`, body);
}

async function resolveGithubToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown): Promise<string> {
  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'github',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
  return accessToken;
}

export const handleGithubCreateIssue: ActionHandler = async (inputs, ctx) => {
  const repo = parseRepo(String(inputs.repo || ''));
  const title = String(inputs.title || '').trim();
  if (!repo) throw new NonRetryableStepError('GitHub repository is required, as "owner/repo"');
  if (!title) throw new NonRetryableStepError('GitHub issue title is required');

  const accessToken = await resolveGithubToken(ctx, inputs.integrationId);

  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/issues`, {
    method: 'POST',
    headers: ghHeaders(accessToken),
    body: JSON.stringify({
      title,
      body: inputs.body ? String(inputs.body) : undefined,
      labels: parseList(inputs.labels),
      assignees: parseList(inputs.assignees),
    }),
  });

  if (!res.ok) await mapGithubError(res);
  const json = (await res.json()) as { number: number; html_url: string };
  return { ok: true, number: json.number, url: json.html_url };
};

export const handleGithubCreateComment: ActionHandler = async (inputs, ctx) => {
  const repo = parseRepo(String(inputs.repo || ''));
  const issueNumber = Number(inputs.issueNumber);
  const body = String(inputs.body || '').trim();
  if (!repo) throw new NonRetryableStepError('GitHub repository is required, as "owner/repo"');
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    throw new NonRetryableStepError('GitHub issue/PR number is required');
  }
  if (!body) throw new NonRetryableStepError('GitHub comment body is required');

  const accessToken = await resolveGithubToken(ctx, inputs.integrationId);

  const res = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
    { method: 'POST', headers: ghHeaders(accessToken), body: JSON.stringify({ body }) },
  );

  if (!res.ok) await mapGithubError(res);
  const json = (await res.json()) as { id: number; html_url: string };
  return { ok: true, id: json.id, url: json.html_url };
};
