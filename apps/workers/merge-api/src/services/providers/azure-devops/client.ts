/**
 * Azure DevOps Services REST (`api-version=7.1`). The connection's `host` is the
 * organisation URL (`https://dev.azure.com/<org>`); the token is an Entra ID
 * bearer token on the context (`memberToken`). A repository's `externalId` is
 * its GUID, `externalProject` the project name.
 */

import { trimTrailingSlashes } from '@weldsuite/merge-domain/providers/shared';
import { ProviderCredentialsError } from '../errors';
import { bearerAuth, createApiClient, type ApiClient } from '../provider-http';
import type { AdapterContext, RepositoryRef } from '../types';

export const API_VERSION = 'api-version=7.1';
export const AZURE_PAGE = 100;
export const AZURE_PAGES = 3;
export const BACKFILL_DAYS = 30;
export const BACKFILL_CAP = 300;

/** The organisation URL of a connection (no trailing slash); a connection without one has not chosen yet. */
export function azureOrganizationBase(ctx: AdapterContext): string {
  const host = ctx.connection.host?.trim();
  if (!host) throw new ProviderCredentialsError('azure_devops', 'The Azure DevOps connection has no organisation yet');
  return trimTrailingSlashes(host);
}

export function azureClient(ctx: AdapterContext): ApiClient {
  return createApiClient('azure_devops', azureOrganizationBase(ctx), bearerAuth('azure_devops', ctx));
}

/** `/{project}/_apis/git/repositories/{id}`. */
export function azureRepoPath(repository: Pick<RepositoryRef, 'externalId' | 'externalProject' | 'fullName'>): string {
  const project = repository.externalProject ?? repository.fullName.split('/')[0] ?? '';
  return `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository.externalId)}`;
}

export interface AzureRepository {
  id: string;
  name: string;
  isDisabled?: boolean;
  defaultBranch?: string | null;
  webUrl?: string | null;
  project?: { id?: string; name?: string; visibility?: string } | null;
}

export interface AzureList<T> {
  value?: T[];
}
