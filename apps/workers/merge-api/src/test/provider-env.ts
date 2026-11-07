/** The env the provider tests run with: the keyring, the OAuth apps and the public URLs. */

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { fakeKv } from './fake-http';

export const ENCRYPTION_KEY = 'ab'.repeat(32);

export const PROVIDER_ENV = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  APP_URL: 'https://app.test',
  WEBHOOK_BASE_URL: 'https://hooks.test',
  GITLAB_OAUTH_CLIENT_ID: 'gl-client',
  GITLAB_OAUTH_CLIENT_SECRET: 'gl-secret',
  BITBUCKET_OAUTH_CLIENT_ID: 'bb-client',
  BITBUCKET_OAUTH_CLIENT_SECRET: 'bb-secret',
  AZURE_DEVOPS_CLIENT_ID: 'az-client',
  AZURE_DEVOPS_CLIENT_SECRET: 'az-secret',
  GITHUB_APP_CLIENT_ID: 'gh-client',
  GITHUB_APP_CLIENT_SECRET: 'gh-secret',
} satisfies Partial<Env>;

/** A fresh env with its own KV (the OAuth state lives there), plus overrides. */
export function providerEnv(extra: Partial<Env> = {}): Partial<Env> {
  return { ...PROVIDER_ENV, WORKSPACE_CACHE: fakeKv(), ...extra };
}

/** One router out of several mounted at the same base (each area owns its own router file). */
export function compose(mounts: Array<[string, Hono<{ Bindings: Env; Variables: Variables }>]>) {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>();
  for (const [path, routes] of mounts) router.route(path, routes);
  return router;
}
