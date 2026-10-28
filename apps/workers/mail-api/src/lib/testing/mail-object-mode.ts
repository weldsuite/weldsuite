/**
 * Shared test doubles for exercising a mail-api route or cron job in
 * `object` mode end-to-end (design task D2's object-mode tests).
 *
 * `WORKSPACE_CACHE` is `@weldsuite/worker-kit/testing/d1`'s own `createMemoryKv`
 * (already used by `cron/snooze-sweep.test.ts`) — it works unmodified as the
 * mailbox directory's KV: `getMailDirectory` builds and caches for real off
 * the same pglite `mail_accounts`/`mail_labels` rows a postgres-mode test
 * seeds (no separate directory fixture needed — see
 * `@weldsuite/mail-domain/store`'s own `store/access.test.ts` for the same
 * "build the directory from the real db" pattern). Re-exported here so every
 * object-mode test imports it from one place.
 *
 * Combine with `@weldsuite/mail-domain/store/object/testing/fake-env`'s
 * `createFakeMailboxNamespace`/`createFakeMailIndexEnv` for the
 * `MAILBOX_STORE`/`MAIL_INDEX` bindings themselves.
 */

export { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';

/** A `FLAGSHIP` double that answers every flag lookup with `mode`, regardless of key — pins `resolveMailStoreMode` without a real Flagship app. */
export function createFixedModeFlagship(mode: string): { getStringValue: (key: string, defaultValue: string, context?: Record<string, unknown>) => Promise<string> } {
  return { getStringValue: async () => mode };
}
