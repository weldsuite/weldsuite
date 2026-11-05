/**
 * GET /api/merge/connections/github/install-url: the GitHub App's install page
 * with a signed state. What must not regress:
 *   1. The answer is the App's install page for the configured slug, carrying
 *      an HS256 state (workspace, member, returnTo, nonce) that connect-api's
 *      verifier accepts and that expires in 600 seconds.
 *   2. `returnTo` is kept only when it is a same-app relative path.
 *   3. Starting the install needs merge_connections:manage; a worker without
 *      the App's slug answers 503.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { verifyInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';
import type { MergeInstallUrlDto } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import connectionsGithubInstallRoutes from './github-install';
import { ADMIN, ALICE, MEMBER, errorCode, makeApp, ok, openDb } from '../../test/helpers';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

const SECRET = 'sk_test_install_state';
const BASE = '/api/merge/connections';
const ENV = { GITHUB_APP_SLUG: 'weldsuite-merge', CLERK_SECRET_KEY: SECRET };

const app = (grants = ADMIN, env: Record<string, unknown> = ENV) =>
  makeApp(db, BASE, connectionsGithubInstallRoutes, { grants, env });

const installUrl = (query = '', grants = ADMIN, env: Record<string, unknown> = ENV) =>
  app(grants, env).request(`${BASE}/github/install-url${query}`);

async function stateOf(url: string) {
  const parsed = new URL(url);
  const state = parsed.searchParams.get('state');
  expect(state).toBeTruthy();
  return { parsed, claims: await verifyInstallStateJwt(state!, SECRET) };
}

describe('GET /connections/github/install-url', () => {
  it('answers the install page of the App with a signed state', async () => {
    const { url } = await ok<MergeInstallUrlDto>(await installUrl());
    const { parsed, claims } = await stateOf(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://github.com/apps/weldsuite-merge/installations/new');
    expect(claims).toMatchObject({ workspaceId: 'ws_alpha', userId: ALICE });
    expect(claims?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims?.returnTo).toBeUndefined();
    expect(claims!.exp - claims!.iat).toBe(600);
  });

  it('does not accept a state signed with another secret', async () => {
    const { url } = await ok<MergeInstallUrlDto>(await installUrl());
    const state = new URL(url).searchParams.get('state')!;
    expect(await verifyInstallStateJwt(state, 'another-secret')).toBeNull();
  });

  it('keeps a same-app returnTo and ignores anything else', async () => {
    const kept = await stateOf((await ok<MergeInstallUrlDto>(await installUrl('?returnTo=%2Fweldmerge%2Fonboarding'))).url);
    expect(kept.claims?.returnTo).toBe('/weldmerge/onboarding');
    for (const bad of ['https%3A%2F%2Fevil.example%2Fx', '%2F%2Fevil.example', 'weldmerge%2Fsettings', '%2Fa%5Cb']) {
      const { claims } = await stateOf((await ok<MergeInstallUrlDto>(await installUrl(`?returnTo=${bad}`))).url);
      expect(claims?.returnTo, bad).toBeUndefined();
    }
  });

  it('needs merge_connections:manage', async () => {
    expect((await installUrl('', MEMBER)).status).toBe(403);
    expect((await installUrl('', [])).status).toBe(403);
  });

  it('answers 503 without the App slug', async () => {
    const res = await installUrl('', ADMIN, { CLERK_SECRET_KEY: SECRET });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('SERVICE_UNAVAILABLE');
  });
});
