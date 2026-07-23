/**
 * GitHub outbound actions (`github.create_issue`, `github.create_comment`).
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'WeldSuite-WeldConnect',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function githubToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown): Promise<string> {
  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'github',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
  if (!credentials.token) throw new Error('GitHub integration has no token');
  return credentials.token;
}

export const handleGithubCreateIssue: ActionHandler = async (inputs, ctx) => {
  const owner = String(inputs.owner || '');
  const repo = String(inputs.repo || '');
  const title = String(inputs.title || '');
  if (!owner || !repo) throw new Error('GitHub owner and repo are required');
  if (!title) throw new Error('GitHub issue title is required');

  const token = await githubToken(ctx, inputs.integrationId);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ title, body: inputs.body ? String(inputs.body) : undefined }),
  });
  const json = (await res.json()) as { number?: number; html_url?: string; message?: string };
  if (!res.ok) throw new Error(`GitHub create issue failed: ${json.message || res.status}`);
  return { created: true, number: json.number, url: json.html_url };
};

export const handleGithubCreateComment: ActionHandler = async (inputs, ctx) => {
  const owner = String(inputs.owner || '');
  const repo = String(inputs.repo || '');
  const issueNumber = Number(inputs.issueNumber);
  const body = String(inputs.body || '');
  if (!owner || !repo) throw new Error('GitHub owner and repo are required');
  if (!Number.isFinite(issueNumber)) throw new Error('GitHub issue/PR number is required');
  if (!body) throw new Error('GitHub comment body is required');

  const token = await githubToken(ctx, inputs.integrationId);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { method: 'POST', headers: ghHeaders(token), body: JSON.stringify({ body }) },
  );
  const json = (await res.json()) as { id?: number; html_url?: string; message?: string };
  if (!res.ok) throw new Error(`GitHub create comment failed: ${json.message || res.status}`);
  return { created: true, id: json.id, url: json.html_url };
};
