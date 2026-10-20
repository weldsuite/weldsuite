/**
 * The `/test-fixtures/*` router, exercised through the real app (`src/index.ts`).
 *
 * Behind it sit seed endpoints and `POST /reset`, a bulk hard delete across a
 * dozen tenant tables of whichever workspace `X-Test-Workspace-Id` names, with
 * no Clerk JWT. It must therefore be served only when ENVIRONMENT is
 * explicitly `development` or `test`; a production deploy, or one whose
 * ENVIRONMENT is missing or misspelled, has to answer 404 before the router's
 * own token check can matter.
 */

import { describe, expect, it } from 'vitest';
import worker from '../../index';

const TOKEN = 'fixtures-token';
const headers = { 'X-Test-Token': TOKEN, 'X-Test-Workspace-Id': 'org_victim', 'Content-Type': 'application/json' };

const call = (path: string, env: Record<string, unknown>, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://app-api.test${path}`, { method: 'POST', headers, body: '{}', ...init }), env as never);

describe('/test-fixtures mount', () => {
  it.each([
    ['production', { ENVIRONMENT: 'production' }],
    ['a missing ENVIRONMENT', {}],
    ['a misspelled ENVIRONMENT (prod)', { ENVIRONMENT: 'prod' }],
    ['a differently cased ENVIRONMENT', { ENVIRONMENT: 'Test' }],
    ['an unlisted ENVIRONMENT (staging)', { ENVIRONMENT: 'staging' }],
  ])('answers 404 for %s, even with the right token', async (_label, env) => {
    const fullEnv = { ...env, TEST_FIXTURES_TOKEN: TOKEN };
    for (const path of ['/test-fixtures/reset', '/test-fixtures/ping', '/test-fixtures/seed/company']) {
      const res = await call(path, fullEnv);
      expect(res.status, path).toBe(404);
    }
  });

  it('answers the same body as an unknown path, so the surface is not advertised', async () => {
    const env = { ENVIRONMENT: 'production', TEST_FIXTURES_TOKEN: TOKEN };
    const hidden = await call('/test-fixtures/reset', env);
    const unknown = await call('/definitely-not-a-route', env);
    expect(hidden.status).toBe(404);
    // The app's notFound envelope echoes the path; apart from that the bodies match.
    expect((await hidden.text()).replace('/test-fixtures/reset', '<path>')).toBe(
      (await unknown.text()).replace('/definitely-not-a-route', '<path>'),
    );
  });

  it('is served in the test environment, behind the token', async () => {
    const env = { ENVIRONMENT: 'test', TEST_FIXTURES_TOKEN: TOKEN };

    const noToken = await call('/test-fixtures/reset', env, { headers: { 'X-Test-Workspace-Id': 'org_victim' } });
    expect(noToken.status).toBe(401);

    const wrongToken = await call('/test-fixtures/reset', env, {
      headers: { ...headers, 'X-Test-Token': `${TOKEN}x` },
    });
    expect(wrongToken.status).toBe(401);

    // Right token, no workspace header: the guard stops before any database work.
    const noWorkspace = await call('/test-fixtures/reset', env, { headers: { 'X-Test-Token': TOKEN } });
    expect(noWorkspace.status).toBe(400);
  });

  it('is served in the development environment, but a missing token secret answers 503', async () => {
    const res = await call('/test-fixtures/reset', { ENVIRONMENT: 'development' });
    expect(res.status).toBe(503);
  });
});
