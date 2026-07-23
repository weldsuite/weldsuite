/**
 * Security-critical tests for `testFixturesGuard`. The router only
 * exists in test/preview envs — these tests pin the contract so a
 * regression that ships the route to production would fail in CI
 * before deploy.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { testFixturesGuard } from './test-fixtures-guard';

vi.mock('../db', () => ({
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

describe('testFixturesGuard', () => {
  it('returns 404 when ENVIRONMENT === "production"', async () => {
    const res = await makeApp().request(
      '/ok',
      { headers: { 'X-Test-Token': 'super-secret-token', 'X-Test-Workspace-Id': 'org_x' } },
      { ...validEnv, ENVIRONMENT: 'production' },
    );
    expect(res.status).toBe(404);
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
