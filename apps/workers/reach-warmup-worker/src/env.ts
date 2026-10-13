import type { FlagshipBinding } from '@weldsuite/feature-flags/server';

/** `reach-warmup-send` message: send this scheduled warmup email. */
export interface WarmupSendMessage {
  /** master `reach_warmup_messages.id` */
  messageId: string;
}

/** `reach-warmup-engage` message: find and act on this sent warmup email in the recipient's mailbox. */
export interface WarmupEngageMessage {
  /** master `reach_warmup_messages.id` */
  messageId: string;
}

export interface Env {
  ENVIRONMENT: string;
  /** Master DB (pool + warmup messages). This worker never opens a tenant DB. */
  DATABASE_URL_MASTER: string;
  /** Seals the pool mailboxes' SMTP/IMAP logins; same value as on reach-api. */
  WELDREACH_WARMUP_KEY?: string;

  WARMUP_SEND_QUEUE?: Queue<WarmupSendMessage>;
  WARMUP_ENGAGE_QUEUE?: Queue<WarmupEngageMessage>;
  /** Generated corpus (`reach-warmup/corpus/*.json`). */
  STORAGE?: R2Bucket;
  /** Kill switch `weldreach-warmup` (default on). */
  FLAGSHIP?: FlagshipBinding;

  /** @weldsuite/ai (monthly corpus refresh). */
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AI_GATEWAY?: string;
  AI_GATEWAY_PROVIDER?: string;
}
