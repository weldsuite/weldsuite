import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';

/** One `reach-send` queue message: send whatever is due in this workspace. */
export interface ReachSendMessage {
  /** Clerk org id (the due-index workspace key; opens the tenant DB). */
  clerkOrgId: string;
  /** Epoch ms the sweep enqueued it, for lag logging. */
  enqueuedAt: number;
}

/**
 * reach-api bindings: the kit's (auth, tenant DB, flags) plus what WeldReach
 * uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** D1 schedule index (`workspace_due_index`, kinds reach_send / reach_warmup). */
  SCHEDULE_INDEX?: D1Database;
  /** Fan-out of due workspaces from the cron sweep to the send consumer. */
  REACH_SEND_QUEUE?: Queue<ReachSendMessage>;
  /** Raw inbound replies (`reach/<orgId>/<messageId>.eml`). */
  STORAGE?: R2Bucket;

  /** WeldSuite's Mailpool account (secret). */
  MAILPOOL_API_KEY?: string;
  /** Seals mailbox logins for the warmup network pool (secret; same value on reach-warmup-worker). */
  WELDREACH_WARMUP_KEY?: string;
  /** Shared secret Mailpool signs webhooks with (secret). */
  MAILPOOL_WEBHOOK_SECRET?: string;
  /** Defaults to https://app.mailpool.io/v1/api. */
  MAILPOOL_API_URL?: string;
  /** Subdomain forwarded replies arrive on (`reply+<token>@…`): reply.weldreach.com (prod) / reply-test.weldreach.com (test). */
  REACH_INBOUND_DOMAIN?: string;

  /** @weldsuite/ai (reply classification). */
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AI_GATEWAY?: string;
  AI_GATEWAY_PROVIDER?: string;
}

export type Variables = KitVariables & {
  /** Set by appAccessGate('weldreach'): status, staff-set limits, billing state. */
  appAccess: AppAccess;
};
