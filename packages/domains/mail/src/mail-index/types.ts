/**
 * Types for `MailIndex`, the per-workspace EU-jurisdiction Durable Object that
 * holds correspondents and the address index (design decision 1,
 * docs/plans/weldmail-mailbox-store-design.md §0 "Decisions"). Originally
 * designed as ledger tables (§3.9 of that doc); the owner moved them to their
 * own object because they hold email addresses and the ledger is not an
 * EU-jurisdiction object (MAIL-009 requires EU for anything holding mail
 * addresses).
 *
 * `store/types.ts` (task A3, not landed in this worktree yet) will define the
 * canonical `MailStoreMode`. `MailIndexModeHint` below is a local copy of that
 * same four-value shape so this module doesn't have to wait on A3; once
 * `store/types.ts` lands, replace this with an import of `MailStoreMode` and
 * delete this type.
 */

/** Mirrors the eventual `store/types.ts` `MailStoreMode`. */
export type MailIndexModeHint = 'postgres' | 'shadow' | 'object' | 'object-only';

/** One correspondents row, the shape `recordMailAddresses`/seeding work with (epoch ms, not `Date`). */
export interface CorrespondentRow {
  email: string;
  firstInboundAt: number | null;
  lastInboundAt: number | null;
  inboundCount: number;
  firstOutboundAt: number | null;
  lastOutboundAt: number | null;
  outboundCount: number;
  repliedAfterFirstContact: boolean;
}

/**
 * One inbound (or sent) message's address fan-out, pushed by a mailbox's
 * outbox (mailbox-object, not built in this worktree yet). `recordMailAddresses`
 * is idempotent per `messageId`, so outbox retries after a partial failure
 * never double-count.
 */
export interface MailAddressBatchEntry {
  /** The mailbox-object message id; the idempotency key. */
  messageId: string;
  /** The mailbox (`mail_accounts.id`) the message belongs to; keys `address_index`. */
  accountId: string;
  /** Epoch ms: the message's received/sent time. */
  at: number;
  /**
   * The external sender's address, when this is an inbound message
   * (`source !== 'sent'`); `null`/absent for a sent copy, which is recorded
   * through `recordOutbound` instead — exactly like the 0214 trigger only
   * fires `WHEN (NEW.source IS DISTINCT FROM 'sent')`.
   */
  from?: string | null;
  /** Every participant address on the message (from/to/cc/bcc), for `address_index`. */
  addresses: string[];
}

export interface RecordMailAddressesResult {
  /** Entries that were new and got applied. */
  applied: number;
  /** Entries already seen (by `messageId`): skipped, not double-counted. */
  skipped: number;
}

export interface FirstContactsResult {
  /**
   * True only when the index is fully seeded from Postgres and the caller
   * says the workspace's mail-store mode is `object-only`. The object never
   * reads Flagship itself; the caller resolves the mode and passes it in.
   */
  authoritative: boolean;
  /** The subset of the input recipients nobody here ever wrote in from. */
  firstContact: string[];
}

export type MailIndexSeedState = 'idle' | 'running' | 'done' | 'failed';

export interface MailIndexSeedingState {
  state: MailIndexSeedState;
  /** Caller-supplied label for why seeding started (e.g. `'workspace-open'`, `'admin'`). Logged, not interpreted. */
  source: string | null;
  /** Keyset cursor into `mail_correspondents.email`; `null` means "start from the top" or "done". */
  cursor: string | null;
  startedAt: number | null;
  copied: number;
  attempts: number;
  lastError: string | null;
}

export interface MailIndexStatus {
  seeded: boolean;
  seeding: MailIndexSeedingState;
  correspondentsCount: number;
  addressIndexCount: number;
  appliedMessagesCount: number;
  databaseSize: number;
}

/** One page of `mail_correspondents`, read from Postgres by whatever reads it (see `correspondents-reader.ts`). */
export interface CorrespondentsPage {
  rows: CorrespondentRow[];
  /** The next page's cursor (the last row's email); `null` when this was the last page. */
  nextCursor: string | null;
}

/**
 * Reads one page of `mail_correspondents` for a workspace, ordered by email.
 * The production implementation (`correspondents-reader.ts`) opens the tenant
 * DB directly; tests inject a stub through `MailIndexEnv.correspondentsReader`
 * since the Durable Object fakes used here (`@weldsuite/worker-kit/testing/
 * durable-sqlite`) have no real Postgres to read from.
 */
export type CorrespondentsReader = (workspaceId: string, cursor: string | null, limit: number) => Promise<CorrespondentsPage>;
