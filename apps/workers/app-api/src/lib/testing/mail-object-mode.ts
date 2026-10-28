/**
 * Shared test doubles for exercising an app-api route in `object`/`object-
 * only` mode end-to-end (design task D6's object-mode tests): a working
 * in-memory `WORKSPACE_CACHE` (so `getMailDirectory` builds and caches for
 * real off the same pglite `mail_accounts`/`mail_labels` rows a postgres-mode
 * test seeds — no separate directory fixture needed, see
 * `@weldsuite/mail-domain/store`'s own `store/access.test.ts` for the same
 * "build the directory from the real db" pattern), and a `FLAGSHIP` stub that
 * pins `resolveMailStoreMode` to whichever mode the test wants instead of the
 * real Flagship binding.
 *
 * Combine with `@weldsuite/mail-domain/store/object/testing/fake-env`'s
 * `createFakeMailboxNamespace`/`createFakeMailIndexEnv` for the
 * `MAILBOX_STORE`/`MAIL_INDEX` bindings themselves, and
 * `@weldsuite/worker-kit/testing/r2`'s `createMemoryR2` for `MAIL_STORAGE`.
 *
 * Deliberately duplicated from mail-api's identical `lib/testing/mail-object-
 * mode.ts` rather than imported — workers never import each other's folders,
 * and this is test-only glue, not product logic.
 */

/** A `KVNamespace` double backed by a plain `Map` — enough for the directory cache's `get`/`put` (json and text). */
export function createMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    }) as KVNamespace['get'],
    put: (async (key: string, value: string) => {
      store.set(key, value);
    }) as KVNamespace['put'],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace['delete'],
    list: (async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })) as unknown as KVNamespace['list'],
  } as unknown as KVNamespace;
}

/** A `FLAGSHIP` double that answers every flag lookup with `mode`, regardless of key — pins `resolveMailStoreMode` without a real Flagship app. */
export function createFixedModeFlagship(mode: string): {
  getStringValue: (key: string, defaultValue: string, context?: Record<string, unknown>) => Promise<string>;
} {
  return { getStringValue: async () => mode };
}
