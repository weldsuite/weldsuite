/**
 * Resolves a feature-flag evaluator for the request and attaches it to the
 * Hono context as `c.get('flags')`. Routes can then call
 * `c.get('flags').isOn('flag-key')` to gate behaviour.
 *
 * Implementation lives in `@weldsuite/feature-flags/server` so the same
 * resolver works in any Worker with a `WORKSPACE_CACHE` KV binding.
 *
 * ── Test-only override ───────────────────────────────────────────────────
 * E2E/integration callers can force flags ON via an `X-Test-Flags` header
 * (comma-separated flag keys). This is gated by the SAME env + token guard as
 * the `/test-fixtures/*` routes (`test-fixtures-guard.ts`): it only applies
 * when `ENVIRONMENT !== 'production'` AND `X-Test-Token` matches the
 * `TEST_FIXTURES_TOKEN` secret. It is therefore inert in production and
 * un-spoofable without the secret — it lets a Playwright spec turn a
 * Flagship-gated flag on for both the UI (`GET /api/feature-flags`) and the
 * server gate (e.g. `POST /api/tasks/:id/move`) in one self-contained run,
 * with no Flagship dependency.
 */

import { createMiddleware } from 'hono/factory';
import { getFlags, type FlagContext } from '@weldsuite/feature-flags/server';
import type { Env } from '../types';

/**
 * Wrap a resolved evaluator so any key in `forced` reports ON, delegating to
 * the real evaluator for every other key.
 */
function applyTestFlagOverrides(base: FlagContext, forced: Set<string>): FlagContext {
  return {
    isOn: ((key, overrides) =>
      forced.has(key as string)
        ? Promise.resolve(true)
        : base.isOn(key as never, overrides)) as FlagContext['isOn'],
    getValue: ((key, overrides) =>
      forced.has(key as string)
        ? Promise.resolve(true)
        : base.getValue(key as never, overrides)) as FlagContext['getValue'],
  };
}

export const featureFlagsMiddleware = () => {
  return createMiddleware<{
    Bindings: Env;
    Variables: { flags: FlagContext };
  }>(async (c, next) => {
    let flags = await getFlags(c);

    // Test-only flag override — same gate as the _test-fixtures routes.
    const testFlags = c.req.header('X-Test-Flags');
    if (testFlags && c.env.ENVIRONMENT !== 'production') {
      const expected = (c.env as Env & { TEST_FIXTURES_TOKEN?: string }).TEST_FIXTURES_TOKEN;
      if (expected && c.req.header('X-Test-Token') === expected) {
        const forced = new Set(
          testFlags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        if (forced.size > 0) flags = applyTestFlagOverrides(flags, forced);
      }
    }

    c.set('flags', flags);
    await next();
  });
};
