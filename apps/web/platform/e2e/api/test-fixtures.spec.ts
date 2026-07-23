/**
 * API-level smoke for the `/test-fixtures/*` router on app-api. This
 * is the endpoint the rest of the e2e suite leans on to seed and
 * reset state — if it breaks, every CRUD spec silently regresses.
 *
 * Runs in the `api` Playwright project (no browser, no Clerk session).
 */

import { test, expect } from '@playwright/test';
import { isTestFixturesConfigured } from '../helpers/test-fixtures-client';

const baseURL = () => process.env.TEST_API_URL?.replace(/\/$/, '') ?? '';
const token = () => process.env.TEST_FIXTURES_TOKEN ?? '';
const workspaceId = () => process.env.TEST_WORKSPACE_ID ?? '';

test.describe('app-api · /test-fixtures', () => {
  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test('GET /ping returns the workspace id and a non-production marker', async ({ request }) => {
    const res = await request.get(`${baseURL()}/test-fixtures/ping`, {
      headers: {
        'X-Test-Token': token(),
        'X-Test-Workspace-Id': workspaceId(),
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data?.workspaceId).toBe(workspaceId());
    expect(body.data?.environment).not.toBe('production');
  });

  test('rejects requests without the X-Test-Token header', async ({ request }) => {
    const res = await request.get(`${baseURL()}/test-fixtures/ping`, {
      headers: {
        // Deliberately omit X-Test-Token
        'X-Test-Workspace-Id': workspaceId(),
      },
    });
    // 401 (missing token), 403 (bad token), or 404 (production
    // hard-block) — all three are valid rejections; what we DON'T
    // want is a 200 that gives the caller workspace state.
    expect([401, 403, 404]).toContain(res.status());
  });

  test('rejects requests with a wrong X-Test-Token', async ({ request }) => {
    const res = await request.get(`${baseURL()}/test-fixtures/ping`, {
      headers: {
        'X-Test-Token': 'definitely-not-the-real-token',
        'X-Test-Workspace-Id': workspaceId(),
      },
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('POST /reset returns counts envelope', async ({ request }) => {
    const res = await request.post(`${baseURL()}/test-fixtures/reset`, {
      headers: {
        'X-Test-Token': token(),
        'X-Test-Workspace-Id': workspaceId(),
        'Content-Type': 'application/json',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data?.counts).toBeDefined();
    expect(typeof body.data.counts).toBe('object');
  });

  test('POST /seed/company returns a SeededCompany envelope', async ({ request }) => {
    const res = await request.post(`${baseURL()}/test-fixtures/seed/company`, {
      headers: {
        'X-Test-Token': token(),
        'X-Test-Workspace-Id': workspaceId(),
        'Content-Type': 'application/json',
      },
      data: { name: 'Api E2E Co' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data?.id).toMatch(/^[a-z]+_/);
    expect(body.data?.displayName).toBeTruthy();

    // Cleanup so the spec is idempotent.
    await request.delete(`${baseURL()}/test-fixtures/entity/company/${body.data.id}`, {
      headers: {
        'X-Test-Token': token(),
        'X-Test-Workspace-Id': workspaceId(),
      },
    });
  });
});
