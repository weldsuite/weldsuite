/**
 * Security-critical tests for `testFixturesGuard` and the environment gate. The
 * router seeds and bulk-deletes tenant data without a Clerk JWT, so it is only
 * served in the `development` and `test` environments — these tests pin the
 * contract so a regression that serves it anywhere else (a missing or
 * misspelled `ENVIRONMENT` included) fails in CI before deploy.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  isTestFixturesEnvironment,
  testFixturesEnvironmentGate,
  testFixturesGuard,
  TEST_FIXTURES_ENVIRONMENTS,
} from './test-fixtures-guard';

vi.mock('@weldsuite/worker-kit/db', () => ({
  getTenantDbForWorkspace: vi.fn(async () => ({ /* mock db */ })),
}));

function makeApp() {
  const app = new Hono();
  app.use('*', testFixturesGuard());
  app.get('/ok', (c) => c.json({ ok: true }));
  return app;
}

const validEnv = {
  ENVIRONMENT: 'test',
  TEST_FIXTURES_TOKEN: 'super-secret-token',
} as Record<string, unknown>;

const goodHeaders = { 'X-Test-Token': 'super-secret-token', 'X-Test-Workspace-Id': 'org_x' };

describe('isTestFixturesEnvironment', () => {
  it('allows exactly the development and test environments', () => {
    expect([...TEST_FIXTURES_ENVIRONMENTS].sort()).toEqual(['development', 'test']);
    expect(isTestFixturesEnvironment('development')).toBe(true);
    expect(isTestFixturesEnvironment('test')).toBe(true);
  });

  it('fails closed for production, unknown, misspelled and missing values', () => {
    for (const value of ['production', 'prod', 'Production', 'TEST', ' test', 'staging', 'preview', '', undefined, null]) {
      expect(isTestFixturesEnvironment(value as string | undefined)).toBe(false);
    }
  });
});

describe('testFixturesEnvironmentGate', () => {
  function gatedApp() {
    const app = new Hono();
    app.use('/test-fixtures/*', testFixturesEnvironmentGate());
    app.post('/test-fixtures/reset', (c) => c.json({ reset: true }));
    return app;
  }

  it.each(['production', 'prod', 'staging', ''])('answers 404 for ENVIRONMENT=%j', async (environment) => {
    const res = await gatedApp().request('/test-fixtures/reset', { method: 'POST' }, { ENVIRONMENT: environment });
    expect(res.status).toBe(404);
  });

  it('answers 404 when ENVIRONMENT is not set at all', async () => {
    const res = await gatedApp().request('/test-fixtures/reset', { method: 'POST' }, {});
    expect(res.status).toBe(404);
  });

  it.each(['development', 'test'])('lets ENVIRONMENT=%s through', async (environment) => {
    const res = await gatedApp().request('/test-fixtures/reset', { method: 'POST' }, { ENVIRONMENT: environment });
    expect(res.status).toBe(200);
  });
});

describe('testFixturesGuard', () => {
  it('returns 404 when ENVIRONMENT === "production"', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: goodHeaders },
      { ...validEnv, ENVIRONMENT: 'production' },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when ENVIRONMENT is missing or not an allowed value, even with a valid token', async () => {
    const { ENVIRONMENT: _omitted, ...withoutEnvironment } = validEnv;
    const missing = await makeApp().request('/ok', { headers: goodHeaders }, withoutEnvironment);
    expect(missing.status).toBe(404);

    for (const environment of ['prod', 'Production', 'staging', '']) {
      const res = await makeApp().request('/ok', { headers: goodHeaders }, { ...validEnv, ENVIRONMENT: environment });
      expect(res.status).toBe(404);
    }
  });

  it('serves the development environment', async () => {
    const res = await makeApp().request('/ok', { headers: goodHeaders }, { ...validEnv, ENVIRONMENT: 'development' });
    expect(res.status).toBe(200);
  });

  it('returns 503 when TEST_FIXTURES_TOKEN is not configured', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: { 'X-Test-Token': 'whatever', 'X-Test-Workspace-Id': 'org_x' } },
      { ENVIRONMENT: 'test' },
    );
    expect(res.status).toBe(503);
  });

  it('returns 401 when the token is missing', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: { 'X-Test-Workspace-Id': 'org_x' } },
      validEnv,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token does not match', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: { 'X-Test-Token': 'wrong-token', 'X-Test-Workspace-Id': 'org_x' } },
      validEnv,
    );
    expect(res.status).toBe(401);
  });

  it('compares the token in constant time: a prefix, an extension and an empty token are all refused', async () => {
    for (const token of ['super-secret-toke', 'super-secret-token2', 'x', '']) {
      const res = await makeApp().request(
        '/ok',
        { headers: { 'X-Test-Token': token, 'X-Test-Workspace-Id': 'org_x' } },
        validEnv,
      );
      expect(res.status).toBe(401);
    }
  });

  it('returns 400 when X-Test-Workspace-Id is missing', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: { 'X-Test-Token': 'super-secret-token' } },
      validEnv,
    );
    expect(res.status).toBe(400);
  });

  it('passes through when env + token + workspace are all valid', async () => {
    const res = await makeApp().request(
      '/ok',
      {
        headers: {
          'X-Test-Token': 'super-secret-token',
          'X-Test-Workspace-Id': 'org_test',
        },
      },
      validEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
