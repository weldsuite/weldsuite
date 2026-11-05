/**
 * Fixtures for the issue-sync tests: GitHub issues and comments in REST /
 * webhook shape, a recorder for the bodies sent to GitHub (the shared stub
 * records method and URL only), and a repository set up for sync.
 */

import { vi } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { seedConnection, seedIssue, seedRepository, seedTeam } from './seed';

export interface GithubIssueFixture {
  id?: number;
  number: number;
  title?: string;
  body?: string | null;
  state?: 'open' | 'closed';
  stateReason?: string | null;
  labels?: string[];
  assignee?: string | null;
  author?: string;
  updatedAt?: string;
  pullRequest?: boolean;
  repoFullName?: string;
}

/** An issue in GitHub's REST/webhook shape. */
export function githubIssue(f: GithubIssueFixture) {
  const repo = f.repoFullName ?? 'acme/web';
  return {
    id: f.id ?? 7000 + f.number,
    number: f.number,
    html_url: `https://github.com/${repo}/issues/${f.number}`,
    title: f.title ?? `Issue ${f.number}`,
    body: f.body === undefined ? 'Details' : f.body,
    state: f.state ?? 'open',
    state_reason: f.stateReason ?? null,
    labels: (f.labels ?? []).map((name) => ({ name, color: 'ededed' })),
    assignee: f.assignee ? { login: f.assignee } : null,
    assignees: f.assignee ? [{ login: f.assignee }] : [],
    user: { login: f.author ?? 'octo-author', avatar_url: 'https://avatars.githubusercontent.com/u/9' },
    created_at: '2026-10-30T09:00:00Z',
    updated_at: f.updatedAt ?? '2026-11-02T09:00:00Z',
    ...(f.pullRequest ? { pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${f.number}` } } : {}),
  };
}

export interface GithubCommentFixture {
  id?: number;
  issueNumber: number;
  body?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function githubComment(f: GithubCommentFixture) {
  return {
    id: f.id ?? 8000 + f.issueNumber,
    body: f.body ?? 'A comment',
    user: { login: f.author ?? 'octo-commenter', avatar_url: 'https://avatars.githubusercontent.com/u/10' },
    created_at: f.createdAt ?? '2026-11-02T09:30:00Z',
    updated_at: f.updatedAt ?? f.createdAt ?? '2026-11-02T09:30:00Z',
    issue_url: `https://api.github.com/repos/acme/web/issues/${f.issueNumber}`,
  };
}

function urlText(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export interface RecordedGithubCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Records every call to api.github.com made after `stubGithub` (the token
 * exchange and the installation lookup left out) with its JSON body. Call it
 * right after `stubGithub`: it wraps the stub.
 */
export function recordGithubBodies(): RecordedGithubCall[] {
  const calls: RecordedGithubCall[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlText(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.hostname === 'api.github.com' && !url.pathname.startsWith('/app/installations')) {
        calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      }
      return inner(input, init);
    }),
  );
  return calls;
}

export interface SyncSetup {
  team: typeof schema.mergeTeams.$inferSelect;
  repo: typeof schema.mergeRepositories.$inferSelect;
  connection: typeof schema.mergeConnections.$inferSelect;
}

/** A team, a GitHub connection (installation 4242) and a repository (id 900) in `mode`. */
export async function seedSyncRepository(
  db: Database,
  mode: 'off' | 'import' | 'two_way' = 'two_way',
  repoOverrides: Partial<typeof schema.mergeRepositories.$inferInsert> = {},
): Promise<SyncSetup> {
  const team = await seedTeam(db, 'PLAT');
  const connection = await seedConnection(db, { externalAccountId: '4242' });
  const repo = await seedRepository(db, connection.id, { externalId: '900', teamId: team.id, issueSync: mode, ...repoOverrides });
  return { team, repo, connection };
}

/** Links an issue to GitHub issue `number`, as the sync stores it after an exchange. */
export async function seedExternalLink(
  db: Database,
  issueId: string,
  repositoryId: string,
  number: number,
  overrides: Partial<typeof schema.mergeExternalIssues.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.mergeExternalIssues)
    .values({
      id: generateId('mxi'),
      issueId,
      repositoryId,
      provider: 'github',
      externalId: String(7000 + number),
      number,
      url: `https://github.com/acme/web/issues/${number}`,
      state: 'open',
      checksum: 'stale-checksum',
      lastWriter: 'provider',
      ...overrides,
    })
    .returning();
  return row!;
}

/** A member's linked GitHub account. */
export async function seedAccount(db: Database, userId: string, login: string) {
  await db.insert(schema.mergeProviderAccounts).values({
    id: generateId('mpa'),
    userId,
    provider: 'github',
    login: login.toLowerCase(),
    verifiedAt: new Date(),
  });
}

export { seedIssue };
