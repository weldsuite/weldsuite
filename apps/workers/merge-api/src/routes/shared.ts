import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../types';
import type { HookContext } from '../services/hooks';
import { recordTitleAccess, type RecordTitleAccess } from '../services/record-links';
import { createGithubClient, GithubApiError, GithubNotConfiguredError, type GithubClient } from '../services/github-client';
import { ProviderCredentialsError, ProviderNotConfiguredError } from '../services/providers/errors';
import { ProviderApiError, ProviderUnsupportedError } from '../services/providers/types';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** 422 for a well-formed request the module cannot accept. */
export const unprocessable = (c: Ctx, message: string) =>
  c.json({ error: { code: 'UNPROCESSABLE_ENTITY', message } }, 422);

/** A client that mints this installation's token on first use. */
export const githubClientFor = (c: Ctx) => (installationId: string): GithubClient =>
  createGithubClient(c.env, installationId);

/**
 * GitHub failures as responses: a worker without the App's credentials is a
 * 503, GitHub refusing or failing a 502. Anything else is not ours to answer.
 */
export function githubFailure(c: Ctx, err: unknown): Response | null {
  if (err instanceof GithubNotConfiguredError) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'GitHub is not configured for WeldMerge' } }, 503);
  if (err instanceof GithubApiError) return c.json({ error: { code: 'UPSTREAM_ERROR', message: 'GitHub answered with an error' } }, 502);
  return null;
}

/**
 * Failures of any provider call as responses: GitHub's (`githubFailure`), a
 * provider answering with an error (502 `provider_error`, with its own
 * message), a provider without OAuth credentials on this worker (503), a
 * connection with no usable token (409 `connection_needs_attention`), and a
 * capability the provider lacks (422). Anything else is not ours to answer.
 */
export function providerFailure(c: Ctx, err: unknown): Response | null {
  const github = githubFailure(c, err);
  if (github) return github;
  if (err instanceof ProviderApiError) return c.json({ error: { code: 'provider_error', message: err.message } }, 502);
  if (err instanceof ProviderNotConfiguredError) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: err.message } }, 503);
  if (err instanceof ProviderCredentialsError) return c.json({ error: { code: 'connection_needs_attention', message: err.message } }, 409);
  if (err instanceof ProviderUnsupportedError) return unprocessable(c, err.message);
  return null;
}

/** Which linked records' titles the caller may read (their module's permission, or channel access). */
export const titleAccess = (c: Ctx): RecordTitleAccess =>
  recordTitleAccess(c.get('tenantDb'), c.get('userId'), (permission) => hasContextPermission(c, permission));

/** What the area hooks (issue sync, chat posts) need, from the request. */
export const hookContext = (c: Ctx): HookContext => ({
  db: c.get('tenantDb'),
  env: c.env,
  userId: c.get('userId'),
  workspaceId: c.get('workspaceId'),
  clerkOrgId: c.get('clerkOrgId'),
});
