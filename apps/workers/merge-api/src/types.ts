import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';

/**
 * merge-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the merge module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** The WeldSuite GitHub App (the same one connect-api uses): installation tokens are minted per call. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The App's slug: the install page is `https://github.com/apps/<slug>/installations/new`. */
  GITHUB_APP_SLUG?: string;
  /** The App's user authorization (user-to-server OAuth): members link their own GitHub account. */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;

  // --- OAuth apps for GitLab.com, Bitbucket Cloud and Azure DevOps (Microsoft Entra ID) ---
  GITLAB_OAUTH_CLIENT_ID?: string;
  GITLAB_OAUTH_CLIENT_SECRET?: string;
  BITBUCKET_OAUTH_CLIENT_ID?: string;
  BITBUCKET_OAUTH_CLIENT_SECRET?: string;
  AZURE_DEVOPS_CLIENT_ID?: string;
  AZURE_DEVOPS_CLIENT_SECRET?: string;

  /** The platform SPA's origin: install and OAuth redirects land on it (`/weldmerge/oauth/callback`). */
  APP_URL?: string;
  /** integration-webhook-worker's origin: provider webhooks point at `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<key>`. */
  WEBHOOK_BASE_URL?: string;

  // --- AI (@weldsuite/ai release notes, metered with @weldsuite/core-domain/ai-billing) ---
  CF_ACCOUNT_ID?: string;
  /** The dedicated AI token (Workers AI + AI Gateway); `@weldsuite/ai` falls back to CLOUDFLARE_API_TOKEN. */
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** `anthropic` when the gateway holds a BYOK Anthropic key: the ops ledger books those calls without the Unified Billing fee. */
  AI_BYOK_PROVIDERS?: string;

  /** Shared schedule-index D1: the daily digest due rows (`@weldsuite/worker-kit/due-index`, kind `merge_digest`). */
  SCHEDULE_INDEX?: D1Database;

  // --- Email (publishing release notes), through the outbound guard (@weldsuite/mail-domain/outbound) ---
  SEND_EMAIL?: SendEmail;
  /** mail-api's `OutboundLedger` Durable Object (`script_name` binding). */
  OUTBOUND_LEDGER?: OutboundGuardEnv['OUTBOUND_LEDGER'];
  OUTBOUND_PLATFORM?: OutboundGuardEnv['OUTBOUND_PLATFORM'];
  OUTBOUND_BACKSTOP?: OutboundGuardEnv['OUTBOUND_BACKSTOP'];
}

export type Variables = KitVariables & {
  /** Set by the `MergeInternal` entrypoint: the caller is another worker over a service binding. */
  internalTrusted?: boolean;
};
