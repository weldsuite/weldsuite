/**
 * Shared test doubles for exercising an API worker's route or cron job in
 * `object`/`object-only` mailbox-store mode end-to-end: a working in-memory
 * `WORKSPACE_CACHE` (so `getMailDirectory` builds and caches for real off
 * the same pglite `mail_accounts`/`mail_labels` rows a postgres-mode test
 * seeds — no separate directory fixture needed, see this package's own
 * `store/access.test.ts` for the same "build the directory from the real
 * db" pattern), and a `FLAGSHIP` stub that pins `resolveMailStoreMode` to
 * whichever mode the test wants instead of the real Flagship binding.
 *
 * Combine with `@weldsuite/mail-domain/store/object/testing/fake-env`'s
 * `createFakeMailboxNamespace`/`createFakeMailIndexEnv` for the
 * `MAILBOX_STORE`/`MAIL_INDEX` bindings themselves, and
 * `@weldsuite/worker-kit/testing/r2`'s `createMemoryR2` for `MAIL_STORAGE`.
 *
 * Previously duplicated across mail-api, app-api and crm-api's own
 * `lib/testing/mail-object-mode.ts` (workers never import each other's
 * folders, so each worker kept its own copy); this is the shared source
 * they import from now that the helpers live in the domain package instead
 * of in a worker's own folder. `createMemoryKv` was already just a
 * re-export of `@weldsuite/worker-kit/testing/d1`'s own helper in mail-api's
 * copy; app-api's and crm-api's copies hand-rolled an equivalent `get`/
 * `put`/`delete`(/unused `list`) double instead — nothing here (or in
 * `getMailDirectory`) ever calls `.list()`, so re-exporting the one
 * worker-kit implementation for all three is behavior-preserving.
 */

export { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';

/** A `FLAGSHIP` double that answers every flag lookup with `mode`, regardless of key — pins `resolveMailStoreMode` without a real Flagship app. */
export function createFixedModeFlagship(mode: string): {
  getStringValue: (key: string, defaultValue: string, context?: Record<string, unknown>) => Promise<string>;
} {
  return { getStringValue: async () => mode };
}
