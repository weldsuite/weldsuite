/**
 * Public surface of the mailbox Durable Object (design §3, task C1).
 * mail-api re-exports `MailboxStoreObject` from its own `src/index.ts`
 * (Cloudflare requires Durable Object classes to be exported from the worker
 * entry point); everything else here is for the worker-side client
 * (`../store/object/*`) and tests.
 */

export { MailboxStoreObject, type MailboxStoreObjectEnv, type MailboxStoreRpc, type MailboxStoreStatus, type MailboxStoreStatusCounts } from './mailbox-object';
export { MailboxDestroyedError, MAILBOX_DESTROYED_CODE } from './destroy';
export { getStoredMode, setStoredMode, type ContinuationKind } from './alarm';
