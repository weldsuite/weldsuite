/**
 * The mailbox object's implementation of the mailbox store contracts (design
 * task C2). The router (task C3) picks these in `object`/`object-only`/
 * `shadow` mode; tests and any interim direct caller can import them from
 * here instead of reaching into individual files — mirrors `../postgres`'s
 * barrel.
 */

export { ObjectMailboxStore, type ObjectMailboxStoreEnv } from './mailbox-store';
export { ObjectWorkspaceMailStore, type ObjectWorkspaceMailStoreEnv } from './workspace-store';
export {
  mailboxStubFor,
  mailboxKeyFor,
  isRetryableOp,
  isBatchRetryable,
  isTransientStubError,
  type MailboxStoreRpc,
  type MailboxStoreNamespaceEnv,
  type StubRetryOptions,
} from './stub';
export { mapWithConcurrency } from './concurrency';
export { fanOutToMailboxes, MailboxFanoutError, type FanoutResult } from './fanout';
