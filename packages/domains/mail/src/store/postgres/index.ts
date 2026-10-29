/**
 * The Postgres implementation of the mailbox store contracts (design task
 * B4). The router (task C3) picks this in `postgres`/`shadow` mode; tests and
 * any interim direct caller can import it from here instead of reaching into
 * individual files.
 */

export { PostgresMailboxStore } from './mailbox-store';
export { PostgresWorkspaceMailStore } from './workspace-store';
