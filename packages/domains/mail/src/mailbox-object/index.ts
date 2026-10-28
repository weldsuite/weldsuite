/**
 * Public surface of the mailbox Durable Object (design §3, task C1).
 * mail-api re-exports `MailboxStoreObject` from its own `src/index.ts`
 * (Cloudflare requires Durable Object classes to be exported from the worker
 * entry point); everything else here is for the worker-side client
 * (`../store/object/*`) and tests.
 */

export {
  MailboxStoreObject,
  type MailboxAdminRpc,
  type MailboxStoreObjectEnv,
  type MailboxStoreRpc,
  type MailboxStoreStatus,
  type MailboxStoreStatusCounts,
} from './mailbox-object';
export { MailboxDestroyedError, MAILBOX_DESTROYED_CODE } from './destroy';
export { getStoredMode, setStoredMode, type ContinuationKind } from './alarm';
// Task C4 (backfill/catch-up, full parity, reverse sync, rebuild): types the
// mail-api admin routes (routes/internal-mail-store) need for request/response
// shapes, without reaching into each file individually.
export type { BackfillPhase, BackfillRunState, BackfillState, StartBackfillOptions } from './backfill';
export type { ParityDiff, ParityDiffReason, ParityReport, ParityRowSnapshot, RunParityOptions } from './parity';
export type { ReverseSyncCounts, ReverseSyncOptions, ReverseSyncReport } from './reverse-sync';
