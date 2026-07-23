/**
 * Unit tests for the test-only `X-Test-Flags` override seam in
 * featureFlagsMiddleware. The override must:
 *   - force a listed flag ON only when non-production AND the X-Test-Token
 *     matches TEST_FIXTURES_TOKEN,
 *   - leave unlisted flags at their real/default value,
 *   - be completely inert in production or without the token.
 *
 * No FLAGSHIP binding is provided, so getFlags falls back to catalog defaults
 * (`weldflow-move-task` defaults to false) — which makes the flip to `true`
 * unambiguous evidence that the override fired.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { featureFlagsMiddleware } from './feature-flags';
import type { Env, Variables } from '../types';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'u_test');
    c.set('workspaceId', 'w_test');
    await next();
  });
  app.use('*', featureFlagsMiddleware());
  app.get('/probe', async (c) => {
    const flags = c.get('flags')!;
    return c.json({
      move: await flags.isOn('weldflow-move-task'),
      upgrade: await flags.isOn('upgrade-button'),
    });
  });
  return app;
}

const probe = async (
  env: Partial<Env>,
  headers: Record<string, string>,
): Promise<{ move: boolean; upgrade: boolean }> => {
  const res = await buildApp().request(
    '/probe',
    { headers },
    env as unknown as Record<string, unknown>,
  );
  return (await res.json()) as { move: boolean; upgrade: boolean };
};

const TOKEN = 'secret-test-token';

describe('featureFlagsMiddleware · X-Test-Flags override', () => {
  it('forces a listed flag ON with a valid token in a non-prod env', async () => {
    const body = await probe(
      { ENVIRONMENT: 'test', TEST_FIXTURES_TOKEN: TOKEN },
      { 'X-Test-Token': TOKEN, 'X-Test-Flags': 'weldflow-move-task' },
    );
    expect(body.move).toBe(true);
    // Unlisted flag keeps its real (catalog default) value.
    expect(body.upgrade).toBe(false);
  });

  it('ignores the header when the token is missing/incorrect', async () => {
    const body = await probe(
      { ENVIRONMENT: 'test', TEST_FIXTURES_TOKEN: TOKEN },
      { 'X-Test-Token': 'wrong', 'X-Test-Flags': 'weldflow-move-task' },
    );
    expect(body.move).toBe(false);
  });

  it('ignores the header when no X-Test-Flags is sent', async () => {
    const body = await probe(
      { ENVIRONMENT: 'test', TEST_FIXTURES_TOKEN: TOKEN },
      { 'X-Test-Token': TOKEN },
    );
    expect(body.move).toBe(false);
  });

  it('is inert in production even with a valid token', async () => {
    const body = await probe(
      { ENVIRONMENT: 'production', TEST_FIXTURES_TOKEN: TOKEN },
      { 'X-Test-Token': TOKEN, 'X-Test-Flags': 'weldflow-move-task' },
    );
    expect(body.move).toBe(false);
  });
});
