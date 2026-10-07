import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { handleGithubCreateIssue, handleGithubCreateComment } from './github';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

// A real RSA keypair so `getGithubInstallationToken` (Web Crypto, PKCS#8)
// can actually sign the App JWT during the test — GitHub's own token
// exchange is stubbed below, the JWT itself is minted for real.
const { privateKey: GITHUB_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

/** Stub both legs of a GitHub call: the installation-token exchange (always
 *  the same canned success) and the actual REST call `impl` handles. */
function stubGithub(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return stubFetch((url, init) => {
    if (url.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      );
    }
    return impl(url, init);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github.create_issue / github.create_comment (pglite + stubbed GitHub API)', () => {
  let db: Database;

  function ctx(overrides: Parameters<typeof makeActionContext>[0] = {}) {
    return makeActionContext({
      db,
      env: { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY, ...(overrides.env as object) },
      ...overrides,
    });
  }

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'WeldFlow GitHub App',
      type: 'github',
      status: 'connected',
      settings: { installationId: 777 },
    });
  });

  describe('github.create_issue', () => {
    it('rejects with no repo or title before minting a token', async () => {
      const { mock } = stubGithub(() => new Response('{}'));
      await expect(handleGithubCreateIssue({ title: 'hi' }, ctx())).rejects.toThrow(NonRetryableStepError);
      await expect(handleGithubCreateIssue({ repo: 'acme/widgets' }, ctx())).rejects.toThrow(
        NonRetryableStepError,
      );
      await expect(handleGithubCreateIssue({ repo: 'not-owner-slash-repo' }, ctx())).rejects.toThrow(
        NonRetryableStepError,
      );
      expect(mock).not.toHaveBeenCalled();
    });

    it('mints an installation token for the connection and creates the issue', async () => {
      const { calls } = stubGithub((url) =>
        new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/widgets/issues/42' }), {
          status: 201,
        }),
      );

      const result = await handleGithubCreateIssue(
        { repo: 'acme/widgets', title: 'Bug report', body: 'Steps to repro', labels: 'bug, needs-triage', assignees: 'octocat' },
        ctx(),
      );

      expect(result).toEqual({ ok: true, number: 42, url: 'https://github.com/acme/widgets/issues/42' });

      const tokenCall = calls.find((c) => c.url.includes('/access_tokens'));
      expect(tokenCall?.url).toBe('https://api.github.com/app/installations/777/access_tokens');

      const issueCall = calls.find((c) => c.url.endsWith('/issues'));
      expect(issueCall?.url).toBe('https://api.github.com/repos/acme/widgets/issues');
      const body = JSON.parse(String(issueCall?.init?.body));
      expect(body).toEqual({ title: 'Bug report', body: 'Steps to repro', labels: ['bug', 'needs-triage'], assignees: ['octocat'] });
      const headers = issueCall?.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghs_installation_token');
    });

    it('omits labels/assignees/body entirely when left blank', async () => {
      const { calls } = stubGithub(() =>
        new Response(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/widgets/issues/1' }), {
          status: 201,
        }),
      );
      await handleGithubCreateIssue({ repo: 'acme/widgets', title: 'Minimal' }, ctx());
      const issueCall = calls.find((c) => c.url.endsWith('/issues'));
      const body = JSON.parse(String(issueCall?.init?.body));
      expect(Object.keys(body)).toEqual(['title']);
    });
  });

  describe('github.create_comment', () => {
    it('rejects with no repo, issue number or body before minting a token', async () => {
      const { mock } = stubGithub(() => new Response('{}'));
      await expect(handleGithubCreateComment({ issueNumber: 1, body: 'hi' }, ctx())).rejects.toThrow(
        NonRetryableStepError,
      );
      await expect(handleGithubCreateComment({ repo: 'acme/widgets', body: 'hi' }, ctx())).rejects.toThrow(
        NonRetryableStepError,
      );
      await expect(
        handleGithubCreateComment({ repo: 'acme/widgets', issueNumber: 1 }, ctx()),
      ).rejects.toThrow(NonRetryableStepError);
      expect(mock).not.toHaveBeenCalled();
    });

    it('creates the comment on the given issue/PR number', async () => {
      const { calls } = stubGithub(() =>
        new Response(
          JSON.stringify({ id: 999, html_url: 'https://github.com/acme/widgets/issues/5#issuecomment-999' }),
          { status: 201 },
        ),
      );
      const result = await handleGithubCreateComment(
        { repo: 'acme/widgets', issueNumber: 5, body: 'Thanks for the report' },
        ctx(),
      );
      expect(result).toEqual({ ok: true, id: 999, url: 'https://github.com/acme/widgets/issues/5#issuecomment-999' });
      const commentCall = calls.find((c) => c.url.includes('/comments'));
      expect(commentCall?.url).toBe('https://api.github.com/repos/acme/widgets/issues/5/comments');
      expect(JSON.parse(String(commentCall?.init?.body))).toEqual({ body: 'Thanks for the report' });
    });
  });

  describe('error mapping (shared by both actions)', () => {
    it('maps 401 to a non-retryable reconnect message', async () => {
      stubGithub(() => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/reconnect/i);
    });

    it('maps 403 with a rate-limit header to a retryable error carrying retryAfterSeconds', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 45;
      stubGithub(
        () =>
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
          }),
      );
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.toThrow(/rate limit/i);
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
      try {
        await handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
        throw new Error('expected rejection');
      } catch (err) {
        expect((err as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('maps 403 without a rate-limit header to a non-retryable permission error', async () => {
      stubGithub(() => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }));
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/permission/i);
    });

    it('maps 404 to a non-retryable not-found error', async () => {
      stubGithub(() => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/not found/i);
    });

    it('maps 410 to a non-retryable "issues disabled" error', async () => {
      stubGithub(() => new Response(JSON.stringify({ message: 'Issues are disabled for this repo' }), { status: 410 }));
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/disabled/i);
    });

    it('maps 422 to a non-retryable error carrying GitHub\'s own message', async () => {
      stubGithub(
        () =>
          new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ field: 'assignees', code: 'invalid' }] }), {
            status: 422,
          }),
      );
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x', assignees: 'nobody' }, ctx());
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/Validation Failed/);
    });

    it('treats an unmapped 5xx as retryable', async () => {
      stubGithub(() => new Response(JSON.stringify({ message: 'Internal error' }), { status: 500 }));
      const promise = handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, ctx());
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });
  });

  describe('owner membership (shared by every provider action via providers/token.ts)', () => {
    it('refuses once the workflow owner has left the workspace', async () => {
      stubGithub(() => new Response(JSON.stringify({ number: 1, html_url: 'https://x' }), { status: 201 }));
      const c = ctx({ tenant: { workspaceId: 'ws_test', userId: 'user_test', ownerUserId: 'owner_gone' } });
      await expect(handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, c)).rejects.toThrow(
        /no longer a member/i,
      );
    });

    it('runs normally when the owner is still a member', async () => {
      stubGithub(() => new Response(JSON.stringify({ number: 1, html_url: 'https://x' }), { status: 201 }));
      const c = ctx({ tenant: { workspaceId: 'ws_test', userId: 'user_test', ownerUserId: 'owner_1' } });
      const result = (await handleGithubCreateIssue({ repo: 'acme/widgets', title: 'x' }, c)) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  });
});
