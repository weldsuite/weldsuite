/**
 * GitLab REST access (`/api/v4`) for gitlab.com and self-managed hosts. The
 * host is the connection's `host` (null: gitlab.com); the token is on the
 * context (`memberToken`, put there by `adapterContext`). `repository.externalId`
 * is the project id.
 */

import { trimTrailingSlashes } from '@weldsuite/merge-domain/providers/shared';
import { bearerAuth, createApiClient, type ApiClient } from '../provider-http';
import type { AdapterContext, RepositoryRef } from '../types';

export const GITLAB_COM = 'https://gitlab.com';
export const GITLAB_PAGE = 100;
export const GITLAB_PAGES = 5;
export const BACKFILL_DAYS = 30;
export const BACKFILL_CAP = 300;

/** The base URL of a GitLab host (no trailing slash); null or empty is gitlab.com. */
export const gitlabBase = (host: string | null | undefined): string =>
  trimTrailingSlashes(host?.trim() ? host.trim() : GITLAB_COM);

export function gitlabClient(ctx: AdapterContext): ApiClient {
  return createApiClient('gitlab', `${gitlabBase(ctx.connection.host)}/api/v4`, bearerAuth('gitlab', ctx));
}

export const projectPath = (repository: Pick<RepositoryRef, 'externalId'>): string =>
  `/projects/${encodeURIComponent(repository.externalId)}`;

export interface GitlabProject {
  id: number;
  path_with_namespace: string;
  visibility?: string;
  default_branch?: string | null;
  web_url?: string | null;
  namespace?: { full_path?: string | null } | null;
}
