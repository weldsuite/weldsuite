/**
 * Public surface of the mailbox store contracts (design §2). Re-exports the
 * types other packages and workers consume; implementations (Postgres, the
 * object, the router) live in their own tasks and files under this
 * directory.
 */

export * from './types';
