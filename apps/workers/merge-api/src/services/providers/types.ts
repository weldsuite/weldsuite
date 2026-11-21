/**
 * The provider seam (weldsuite-documentation/plans/weldmerge-phases-2-5.md, phase 3). One folder
 * per provider next to this file (`github/`, `gitlab/`, `bitbucket/`,
 * `azure-devops/`) implements these interfaces; `registry.ts` picks the
 * implementation for a provider. Everything above this seam (pr-sync, issue
 * sync, review, releases) is provider-neutral and works on the normalized
 * shapes below.
 *
 * No Hono context in adapters: they get an `AdapterContext` and return plain
 * values. HTTP in tests is stubbed by URL and method (test/helpers.ts), so
 * every outbound call must be deterministic for a given input.
 */

import type {
  MergeChecksStatus,
  MergeIssueSyncMode,
  MergeProvider,
  MergeReviewDecision,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type {
  MergeDiffSide,
  MergeMethod,
  MergePullRequestFile,
  MergeReviewEvent,
  MergeReviewThread,
  MergeThreadComment,
} from '@weldsuite/app-api-client/schemas/weldmerge-review';
import type { MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { MirrorFields } from '@weldsuite/merge-domain/github';
import type { Env } from '../../types';
import type { MergeConnectionRow } from '../db';

export type { MirrorFields };

/** Raised when a provider has no implementation of what was asked (a 422 for the member). */
export class ProviderUnsupportedError extends Error {
  constructor(
    readonly provider: MergeProvider,
    readonly capability: string,
  ) {
    super(`${provider} does not support ${capability}`);
    this.name = 'ProviderUnsupportedError';
  }
}

/** The provider answered with an error: `status` and its own `message` (a 502 `provider_error`). */
export class ProviderApiError extends Error {
  constructor(
    readonly provider: MergeProvider,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }
}

/** What an adapter call acts on: the worker env, the connection, and optionally the member's own token. */
export interface AdapterContext {
  env: Env;
  connection: MergeConnectionRow;
  /**
   * A member's own access token (review and merge run as the member). Absent:
   * the adapter authenticates with the connection (GitHub: an installation
   * token; others: the connection's stored credentials).
   */
  memberToken?: string;
}

/** The repository an adapter call is about, as stored on `merge_repositories`. */
export interface RepositoryRef {
  externalId: string;
  /** `owner/name`. */
  fullName: string;
  /** Bitbucket workspace slug, Azure DevOps project, GitLab namespace path. */
  externalProject: string | null;
  defaultBranch?: string | null;
}

export interface RemoteRepository {
  externalId: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  url: string | null;
  externalProject: string | null;
}

// ---------------------------------------------------------------------------
// Normalized webhook events
// ---------------------------------------------------------------------------

export interface NormalizedIssue {
  externalId: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** GitHub's `state_reason`; null on providers without one. */
  stateReason: 'completed' | 'not_planned' | null;
  labels: string[];
  assigneeLogin: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  updatedAt: Date;
}

export interface NormalizedIssueComment {
  externalId: string;
  issueNumber: number;
  body: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NormalizedWebhookEvent =
  | { kind: 'pull_request'; repositoryExternalId: string; action: string; pullRequest: MirrorFields }
  | {
      kind: 'review';
      repositoryExternalId: string;
      number: number;
      /** Null when the provider only says "something changed": re-read with `reviewDecision`. */
      decision: MergeReviewDecision | null;
    }
  | {
      kind: 'checks';
      repositoryExternalId: string;
      headSha: string;
      status: MergeChecksStatus | null;
      /** Pull request numbers the provider names, when it does. */
      numbers: number[];
    }
  | { kind: 'issue'; repositoryExternalId: string; action: string; issue: NormalizedIssue }
  | {
      kind: 'issue_comment';
      repositoryExternalId: string;
      action: 'created' | 'edited' | 'deleted';
      comment: NormalizedIssueComment;
    }
  | { kind: 'repository_removed'; repositoryExternalId: string };

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface WebhookTarget {
  /** `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<webhook_key>`. */
  url: string;
  /** The fresh secret to register (GitLab `X-Gitlab-Token`, Bitbucket HMAC key, Azure basic-auth password). */
  secret: string;
}

/** Reading a connection: repositories, pull requests, review and check state, webhooks. */
export interface ConnectionAdapter {
  listAvailableRepositories(ctx: AdapterContext): Promise<RemoteRepository[]>;
  /** One repository by its provider id; null when the connection cannot see it. */
  getRepository(ctx: AdapterContext, externalId: string, externalProject?: string | null): Promise<RemoteRepository | null>;
  /** Open pull requests plus those closed or merged in the last 30 days, at most 300. */
  listPullRequestsForBackfill(ctx: AdapterContext, repository: RepositoryRef, now?: Date): Promise<MirrorFields[]>;
  getPullRequest(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<MirrorFields | null>;
  reviewDecision(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<MergeReviewDecision | null>;
  /**
   * `pullRequestNumber`: Azure DevOps reports checks per pull request (statuses
   * and policy evaluations); the other providers read them by commit.
   */
  checksStatus(
    ctx: AdapterContext,
    repository: RepositoryRef,
    headSha: string,
    pullRequestNumber?: number,
  ): Promise<MergeChecksStatus | null>;
  /** GitLab, Bitbucket and Azure DevOps register a hook per repository; GitHub's App delivers events itself. */
  registerWebhook?(ctx: AdapterContext, repository: RepositoryRef, target: WebhookTarget): Promise<{ webhookId: string }>;
  deleteWebhook?(ctx: AdapterContext, repository: RepositoryRef, webhookId: string): Promise<void>;
  /** Checks the request's signature or token against the repository's stored secret. */
  verifyWebhook?(headers: Record<string, string>, rawBody: string, secret: string): Promise<boolean>;
  parseWebhook?(headers: Record<string, string>, body: unknown): NormalizedWebhookEvent[];
}

export interface IssueSyncListOptions {
  state?: 'open' | 'closed' | 'all';
  /** Only issues updated at or after this time. */
  since?: Date;
  /** Cap on how many to return (the import takes up to 500). */
  limit?: number;
}

export interface IssueWriteInput {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | null;
  labels?: string[];
  assigneeLogin?: string | null;
}

/** Issues on GitHub and GitLab: list, read and write them, and their comments. */
export interface IssueSyncAdapter {
  listIssues(ctx: AdapterContext, repository: RepositoryRef, options?: IssueSyncListOptions): Promise<NormalizedIssue[]>;
  getIssue(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<NormalizedIssue | null>;
  createIssue(ctx: AdapterContext, repository: RepositoryRef, input: IssueWriteInput & { title: string }): Promise<NormalizedIssue>;
  updateIssue(ctx: AdapterContext, repository: RepositoryRef, number: number, input: IssueWriteInput): Promise<NormalizedIssue>;
  listComments(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<NormalizedIssueComment[]>;
  createComment(ctx: AdapterContext, repository: RepositoryRef, number: number, body: string): Promise<NormalizedIssueComment>;
}

export interface ReviewLineComment {
  path: string;
  line: number;
  side: MergeDiffSide;
  body: string;
}

/** Phase 4: review and merge. The context carries the member's own token. */
export interface ReviewAdapter {
  listFiles(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<MergePullRequestFile[]>;
  listThreads(ctx: AdapterContext, repository: RepositoryRef, number: number): Promise<MergeReviewThread[]>;
  submitReview(
    ctx: AdapterContext,
    repository: RepositoryRef,
    number: number,
    input: { event: MergeReviewEvent; body?: string; comments?: ReviewLineComment[] },
  ): Promise<void>;
  comment(
    ctx: AdapterContext,
    repository: RepositoryRef,
    number: number,
    input: { body: string; path?: string; line?: number; side?: MergeDiffSide; inReplyToId?: string },
  ): Promise<{ comment: MergeThreadComment; threadId: string | null }>;
  /** Throws `ProviderApiError` with the provider's message when it refuses; `ProviderUnsupportedError` for a method it lacks. */
  merge(
    ctx: AdapterContext,
    repository: RepositoryRef,
    number: number,
    input: { method: MergeMethod; commitTitle?: string; commitMessage?: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface OAuthUser {
  externalId: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** GitLab.com, Bitbucket, Azure DevOps (Entra ID) and GitHub's user authorization. */
export interface OAuthProvider {
  authorizeUrl(env: Env, input: { state: string; redirectUri: string; host?: string | null }): string;
  exchangeCode(env: Env, input: { code: string; redirectUri: string; host?: string | null }): Promise<MergeStoredCredentials>;
  refresh(env: Env, input: { refreshToken: string; host?: string | null }): Promise<MergeStoredCredentials>;
  currentUser(env: Env, input: { accessToken: string; host?: string | null }): Promise<OAuthUser>;
}

/** What a provider folder exports; every part is optional until the provider's area fills it. */
export interface ProviderModule {
  connection?: ConnectionAdapter;
  issues?: IssueSyncAdapter;
  review?: ReviewAdapter;
  oauth?: OAuthProvider;
}

/** The sync modes a provider supports for issues. */
export const ISSUE_SYNC_MODES_BY_PROVIDER: Record<MergeProvider, readonly MergeIssueSyncMode[]> = {
  github: ['off', 'import', 'two_way'],
  gitlab: ['off', 'import', 'two_way'],
  bitbucket: ['off'],
  azure_devops: ['off'],
};
