import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { createGithubClient, GithubApiError, GithubNotConfiguredError, type GithubClient } from '../services/github-client';

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
