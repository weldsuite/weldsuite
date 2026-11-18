/**
 * WeldMerge phase 3 contract: GitLab, Bitbucket and Azure DevOps. OAuth
 * connections, member accounts, and the forwarded provider webhook. Zod v3.
 *
 * Design: weldsuite-documentation/plans/weldmerge-phases-2-5.md.
 */

import { z } from 'zod';
import { MERGE_PROVIDERS } from './weldmerge';

/** Providers a workspace connects with an OAuth app (GitHub installs the GitHub App instead). */
export const MERGE_OAUTH_CONNECTION_PROVIDERS = ['gitlab', 'bitbucket', 'azure_devops'] as const;
export type MergeOauthConnectionProvider = (typeof MERGE_OAUTH_CONNECTION_PROVIDERS)[number];

/** Providers a member links their own account on (GitHub through the App's user authorization). */
export const MERGE_OAUTH_ACCOUNT_PROVIDERS = MERGE_PROVIDERS;
export type MergeOauthAccountProvider = (typeof MERGE_OAUTH_ACCOUNT_PROVIDERS)[number];

/** What an OAuth round trip is for. */
export const MERGE_OAUTH_PURPOSES = ['connection', 'account'] as const;
export type MergeOauthPurpose = (typeof MERGE_OAUTH_PURPOSES)[number];

/** The SPA page every provider redirects to; registered on each OAuth app. */
export const MERGE_OAUTH_CALLBACK_PATH = '/weldmerge/oauth/callback';

/** The OAuth `state` lives in KV `merge_oauth_state:<id>` for this long. */
export const MERGE_OAUTH_STATE_TTL_SECONDS = 600;

/** KV value stored under `merge_oauth_state:<state id>`. */
export const mergeOauthStateSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  provider: z.enum(MERGE_PROVIDERS),
  purpose: z.enum(MERGE_OAUTH_PURPOSES),
  /** Self-managed host for `account` links to GitLab, when set. */
  host: z.string().nullish(),
  returnTo: z.string().nullish(),
});
export type MergeOauthState = z.infer<typeof mergeOauthStateSchema>;

/** Shape of the stored credentials JSON (encrypted at rest, never returned). */
export const mergeStoredCredentialsSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  /** ISO time the access token stops working. */
  expiresAt: z.string().optional(),
  tokenType: z.string().optional(),
});
export type MergeStoredCredentials = z.infer<typeof mergeStoredCredentialsSchema>;

// ---------------------------------------------------------------------------
// Authorize + callback
// ---------------------------------------------------------------------------

/** `GET /connections/:provider/authorize-url?returnTo=` and `GET /accounts/:provider/authorize-url?returnTo=&host=`. */
export const mergeAuthorizeUrlQuerySchema = z.object({
  returnTo: z.string().max(500).optional(),
  /** Self-managed GitLab base URL, for a member account link. */
  host: z.string().url().max(500).optional(),
});
export type MergeAuthorizeUrlQuery = z.input<typeof mergeAuthorizeUrlQuerySchema>;

export const mergeAuthorizeUrlDtoSchema = z.object({ url: z.string() });
export type MergeAuthorizeUrlDto = z.infer<typeof mergeAuthorizeUrlDtoSchema>;

/** `POST /oauth/callback`: what the SPA callback page received from the provider. */
export const mergeOauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
export type MergeOauthCallbackInput = z.input<typeof mergeOauthCallbackSchema>;

export const mergeAzureOrganizationOptionSchema = z.object({
  name: z.string(),
  url: z.string(),
});
export type MergeAzureOrganizationOption = z.infer<typeof mergeAzureOrganizationOptionSchema>;

export const mergeOauthCallbackResultSchema = z.object({
  purpose: z.enum(MERGE_OAUTH_PURPOSES),
  provider: z.enum(MERGE_PROVIDERS),
  returnTo: z.string().nullable(),
  /** The connection created (purpose `connection`). */
  connectionId: z.string().nullable(),
  /** The member account linked (purpose `account`). */
  accountId: z.string().nullable(),
  /**
   * Azure DevOps with more than one organisation: the connection exists but has
   * no organisation yet; choose one with `POST /connections/azure_devops/organization`.
   */
  organizations: z.array(mergeAzureOrganizationOptionSchema).optional(),
});
export type MergeOauthCallbackResult = z.infer<typeof mergeOauthCallbackResultSchema>;

// ---------------------------------------------------------------------------
// Self-managed GitLab, Azure DevOps organisation
// ---------------------------------------------------------------------------

/** `POST /connections/gitlab` (workspace) and `POST /accounts/gitlab-token` (member): validated with `GET {host}/api/v4/user`. */
export const mergeGitlabTokenSchema = z.object({
  host: z.string().url().max(500),
  token: z.string().min(1).max(500),
});
export type MergeGitlabTokenInput = z.input<typeof mergeGitlabTokenSchema>;

/** `POST /connections/azure_devops/organization`. */
export const mergeAzureOrganizationSchema = z.object({
  connectionId: z.string().min(1),
  /** The organisation name, as in `https://dev.azure.com/<organization>`. */
  organization: z.string().trim().min(1).max(255),
});
export type MergeAzureOrganizationInput = z.input<typeof mergeAzureOrganizationSchema>;

/** `DELETE /accounts/:provider?host=`. */
export const mergeUnlinkAccountQuerySchema = z.object({ host: z.string().max(500).optional() });
export type MergeUnlinkAccountQuery = z.input<typeof mergeUnlinkAccountQuerySchema>;

// ---------------------------------------------------------------------------
// Internal: forwarded provider webhook (integration-webhook-worker → MergeInternal)
// ---------------------------------------------------------------------------

/** GitLab, Bitbucket and Azure DevOps; GitHub keeps `mergeGithubEventEnvelopeSchema`. */
export const MERGE_WEBHOOK_PROVIDERS = ['gitlab', 'bitbucket', 'azure_devops'] as const;
export type MergeWebhookProvider = (typeof MERGE_WEBHOOK_PROVIDERS)[number];

/** Request headers integration-webhook-worker passes on (lower-case names), so merge-api can verify the signature. */
export const MERGE_PROVIDER_FORWARDED_HEADERS = [
  'x-gitlab-token',
  'x-gitlab-event',
  'x-hub-signature',
  'x-event-key',
  'authorization',
  'content-type',
] as const;

export const mergeProviderEventEnvelopeSchema = z.object({
  /** `workspaces.id` from the master provider index. */
  workspaceId: z.string().min(1),
  provider: z.enum(MERGE_WEBHOOK_PROVIDERS),
  /** The repository's `webhook_key` from the URL. */
  key: z.string().min(1),
  /** Allow-listed request headers, lower-case names. */
  headers: z.record(z.string()),
  /** The raw request body (the signature covers its exact bytes). */
  body: z.string(),
});
export type MergeProviderEventEnvelope = z.infer<typeof mergeProviderEventEnvelopeSchema>;

/** What `MergeInternal.providerEvent` answers; `reason` is e.g. `bad_signature`, `unknown_repository`. */
export const mergeProviderEventAckSchema = z.object({
  outcome: z.enum(['applied', 'ignored']),
  reason: z.string().optional(),
});
export type MergeProviderEventAck = z.infer<typeof mergeProviderEventAckSchema>;
