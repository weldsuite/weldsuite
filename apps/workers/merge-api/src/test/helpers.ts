/**
 * Shared test plumbing for merge-api's route tests: a real tenant schema
 * (pglite), the entity-event queue, a stub of GitHub's REST API answered by URL
 * and method (never by call order, so the Rust backend can answer the same
 * test in conformance mode), and small request helpers.
 *
 * GitHub App tokens are minted for real, with a key made for the test run:
 * the stub answers the installation-token exchange, so both backends mint the
 * same way and the conformance suite compares that call too.
 */

import { generateKeyPairSync } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

/** The GitHub App's private key for this test run (PKCS#8). */
const { privateKey: GITHUB_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/**
 * How many times each GitHub call is made per request: once, or twice in
 * conformance mode, where the stub answers TypeScript's run and then Rust's.
 */
export const RUNS = conformanceTarget() ? 2 : 1;

/** `calls` as the stub records them for one request: each run's calls, in turn. */
export function perRun<T>(calls: T[]): T[] {
  return Array.from({ length: RUNS }, () => calls).flat();
}

/**
 * The id of a row the request created, as its entity event carries it. In
 * conformance mode the test reads Rust's rows but TypeScript's events, and a
 * new id differs between the two runs by construction: only its prefix is
 * checked there.
 */
export function newId(id: string): unknown {
  return conformanceTarget() ? expect.stringMatching(new RegExp(`^${id.split('_')[0]}_`)) : id;
}

export const ADMIN = [
  'merge_issues:read',
  'merge_issues:create',
  'merge_issues:update',
  'merge_issues:delete',
  'merge_pull_requests:read',
  'merge_pull_requests:review',
  'merge_pull_requests:merge',
  'merge_releases:read',
  'merge_releases:manage',
  'merge_teams:read',
  'merge_teams:manage',
  'merge_connections:read',
  'merge_connections:manage',
];
/** What a MEMBER role holds: everything but the two `manage` keys and issue delete. */
export const MEMBER = [
  'merge_issues:read',
  'merge_issues:create',
  'merge_issues:update',
  'merge_pull_requests:read',
  'merge_pull_requests:review',
  'merge_pull_requests:merge',
  'merge_releases:read',
  'merge_teams:read',
  'merge_connections:read',
];
export const VIEWER = [
  'merge_issues:read',
  'merge_pull_requests:read',
  'merge_releases:read',
  'merge_teams:read',
  'merge_connections:read',
];

export const ALICE = 'user_alice';
export const BOB = 'user_bob';

export const events: EntityEventMessage[] = [];
const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

export function clearEvents() {
  events.length = 0;
}

/** Event types published since the last `clearEvents()`, in order. */
export const eventTypes = () => events.map((e) => e.eventType);

export async function openDb(): Promise<Database> {
  return (await createPgliteDb()).db;
}

/** Empties every merge table (and the GitHub installation rows the connection tests adopt). */
export async function resetTables(db: Database) {
  const s = schema;
  await db.delete(s.mergeRecordLinks);
  await db.delete(s.mergeExternalIssues);
  await db.delete(s.mergeReleasePullRequests);
  await db.delete(s.mergeReleases);
  await db.delete(s.mergeChatSubscriptions);
  await db.delete(s.mergeInboxStates);
  await db.delete(s.mergeIssuePullRequests);
  await db.delete(s.mergeComments);
  await db.delete(s.mergePullRequests);
  await db.delete(s.mergeIssues);
  await db.delete(s.mergeCycles);
  await db.delete(s.mergeLabels);
  await db.delete(s.mergeRepositories);
  await db.delete(s.mergeConnections);
  await db.delete(s.mergeTeams);
  await db.delete(s.mergeProviderAccounts);
  await db.delete(s.githubConnections);
  clearEvents();
}

export interface AppOptions {
  grants?: string[];
  userId?: string;
  env?: Partial<Env>;
}

export function makeApp(
  db: Database,
  base: string,
  router: Hono<{ Bindings: Env; Variables: Variables }>,
  options: AppOptions = {},
) {
  return createTestApp(base, router, {
    context: {
      permissions: permissions(...(options.grants ?? ADMIN)),
      tenantDb: db,
      userId: options.userId ?? ALICE,
      orgId: 'org_alpha',
      workspaceId: 'ws_alpha',
      clerkOrgId: 'org_alpha',
    },
    env: { ENTITY_EVENTS: queue, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY, ...options.env },
    moduleApiErrors: true,
  });
}

export const jsonInit = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** Calls an endpoint and checks the status; returns the `data` of the answer. */
export async function ok<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return data<T>(res);
}

// ---------------------------------------------------------------------------
// GitHub's REST API
// ---------------------------------------------------------------------------

export interface GithubCall {
  method: string;
  url: string;
}

/** A body, a function of the URL returning one, or a ready `Response` (to answer with an error status). */
export type GithubAnswer = unknown | ((url: URL) => unknown);

/** The `fetch` loopback calls go to: the conformance harness's own (the Rust server and its bridges). */
const realFetch = globalThis.fetch;

function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

/** `POST /app/installations/:id/access_tokens`: the token exchange every mint makes. */
const TOKEN_EXCHANGE = /^\/app\/installations\/\d+\/access_tokens$/;

/**
 * Stubs `fetch` for api.github.com. `answers` maps `<METHOD> <path>` (no query)
 * to a body or a function of the URL; anything else is a 404. The
 * installation-token exchange is answered with a token that expires within
 * five minutes, so no backend keeps it between requests. Returns the calls
 * made (the exchange left out), in order.
 */
export function stubGithub(answers: Record<string, GithubAnswer>): GithubCall[] {
  const calls: GithubCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (isLoopback(url)) return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && TOKEN_EXCHANGE.test(url.pathname)) {
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        return new Response(JSON.stringify({ token: 'ghs_test_token', expires_at: expiresAt }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      calls.push({ method, url: url.pathname + url.search });
      const answer = answers[`${method} ${url.pathname}`];
      if (answer === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      const body = typeof answer === 'function' ? (answer as (u: URL) => unknown)(url) : answer;
      // A ready answer serves both backends in conformance mode: hand out copies.
      if (body instanceof Response) return body.clone();
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

export interface GithubPullFixture {
  id: number;
  number: number;
  title: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  headRef?: string;
  body?: string | null;
  login?: string;
  updatedAt?: string;
  createdAt?: string;
  mergedAt?: string | null;
  headSha?: string;
  reviewers?: string[];
  repoFullName?: string;
}

/** A pull request in GitHub's REST/webhook shape. */
export function githubPull(f: GithubPullFixture) {
  const state = f.state ?? 'open';
  const merged = f.merged === true;
  return {
    id: f.id,
    number: f.number,
    title: f.title,
    body: f.body ?? null,
    state: merged ? 'closed' : state,
    draft: f.draft ?? false,
    merged,
    merged_at: merged ? (f.mergedAt ?? f.updatedAt ?? '2026-11-01T10:00:00Z') : null,
    closed_at: state === 'closed' || merged ? (f.updatedAt ?? '2026-11-01T10:00:00Z') : null,
    created_at: f.createdAt ?? '2026-10-30T09:00:00Z',
    updated_at: f.updatedAt ?? '2026-11-01T10:00:00Z',
    html_url: `https://github.com/${f.repoFullName ?? 'acme/web'}/pull/${f.number}`,
    user: { login: f.login ?? 'Octo-Dev', id: 7, avatar_url: 'https://avatars.githubusercontent.com/u/7' },
    head: { ref: f.headRef ?? `feature/${f.number}`, sha: f.headSha ?? `sha${f.number}` },
    base: { ref: 'main', repo: { id: 900, full_name: f.repoFullName ?? 'acme/web' } },
    additions: 10,
    deletions: 2,
    changed_files: 3,
    requested_reviewers: (f.reviewers ?? []).map((login) => ({ login, id: 1, avatar_url: null })),
    requested_teams: [],
    labels: [{ name: 'bug', color: 'd73a4a' }],
  };
}
