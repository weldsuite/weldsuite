/**
 * `/test-fixtures/seed/mail-message`, `/seed/mail-messages-bulk` and `/reset`
 * under the mailbox store's `object-only` mode (docs/plans/weldmail-mailbox-
 * store-design.md, task D6): seeding must ingest through the mailbox store
 * instead of inserting into Postgres, and `/reset` must clear the object too,
 * not just (today, in this mode, nonexistent) Postgres rows.
 *
 * `object-only` rather than `object` specifically: in `object` mode Postgres
 * is a dual-write *secondary*, applied via `waitUntil` — with no real
 * `ExecutionContext` in this harness that write is a detached, unawaited
 * promise, so asserting "no Postgres row" right after the response would
 * race it. `object-only` has no Postgres secondary at all, so the absence is
 * deterministic.
 *
 * `getWorkspaceContextForOrg` is mocked exactly like `./teardown-workspace.
 * test.ts` does, so `testFixturesGuard` resolves the real pglite tenant `db`
 * from the `X-Test-Workspace-Id` header without a master DB.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { ObjectWorkspaceMailStore, type ObjectWorkspaceMailStoreEnv } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace, createFakeMailIndexEnv } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import { createMemoryKv, createFixedModeFlagship } from '@weldsuite/mail-domain/store/testing/object-mode';

const WORKSPACE_ID = 'ws_e2e_object';
const CLERK_ORG_ID = 'org_e2e_object';
const TOKEN = 'fixtures-token';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  // The guard resolves X-Test-Workspace-Id into the request context.
  getWorkspaceContextForOrg: async () => ({ id: WORKSPACE_ID, clerkOrgId: CLERK_ORG_ID, db: holder.db }),
}));

// eslint-disable-next-line import/first -- must follow the vi.mock above
import { testFixturesRoutes } from './index';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  holder.db = db;
}, 60_000);

beforeEach(() => {
  __resetMailStoreModeCacheForTests();
});

/** A fresh fake mailbox namespace + its own in-memory R2/KV/index, wired for `object-only` mode. */
function makeEnv() {
  const { namespace, stubs } = createFakeMailboxNamespace();
  const bucket = createMemoryR2();
  const mailIndexEnv = createFakeMailIndexEnv();
  const env = {
    ENVIRONMENT: 'test',
    TEST_FIXTURES_TOKEN: TOKEN,
    FLAGSHIP: createFixedModeFlagship('object-only'),
    WORKSPACE_CACHE: createMemoryKv(),
    MAILBOX_STORE: namespace,
    MAIL_STORAGE: bucket,
    MAIL_INDEX: mailIndexEnv.MAIL_INDEX,
  };
  return { env, namespace, bucket, mailIndexEnv, stubs };
}

/** A client against the SAME fake namespace, for assertions independent of the route under test. */
function clientFor(mailEnv: ReturnType<typeof makeEnv>['env']): ObjectWorkspaceMailStore {
  return new ObjectWorkspaceMailStore(mailEnv as ObjectWorkspaceMailStoreEnv, WORKSPACE_ID, CLERK_ORG_ID);
}

const call = (path: string, env: Record<string, unknown>, body: unknown = {}) =>
  testFixturesRoutes.request(
    path,
    {
      method: 'POST',
      headers: { 'X-Test-Token': TOKEN, 'X-Test-Workspace-Id': CLERK_ORG_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env as never,
  );

describe('POST /test-fixtures/seed/mail-message (object-only mode)', () => {
  it('ingests through the mailbox store, never Postgres', async () => {
    const { env } = makeEnv();
    const res = await call('/seed/mail-message', env, { subject: 'Hello object mode' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; accountId: string; subject: string } };
    expect(body.data.subject).toBe('Hello object mode');

    const pgRows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, body.data.id));
    expect(pgRows).toEqual([]);

    const store = clientFor(env);
    const fromObject = await store.mailbox(body.data.accountId).getMessage(body.data.id);
    expect(fromObject?.subject).toBe('Hello object mode');
  });
});

describe('POST /test-fixtures/seed/mail-messages-bulk (object-only mode)', () => {
  it('ingests every row through the mailbox store, never Postgres', async () => {
    const { env } = makeEnv();
    const res = await call('/seed/mail-messages-bulk', env, { count: 7, threadSize: 3 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { accountId: string; inserted: number; threads: number } };
    expect(body.data.inserted).toBe(7);
    expect(body.data.threads).toBe(3);

    const pgRows = await db
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.accountId, body.data.accountId));
    expect(pgRows).toEqual([]);

    const store = clientFor(env);
    const stats = await store.mailbox(body.data.accountId).stats();
    expect(stats.total).toBe(7);
  });
});

describe('POST /test-fixtures/reset (object-only mode)', () => {
  it('clears seeded messages from the mailbox object, not just Postgres', async () => {
    const { env } = makeEnv();
    const seedRes = await call('/seed/mail-message', env, { subject: 'To be reset' });
    const seeded = (await seedRes.json()) as { data: { id: string; accountId: string } };

    const store = clientFor(env);
    expect((await store.mailbox(seeded.data.accountId).getMessage(seeded.data.id))?.id).toBe(seeded.data.id);

    const resetRes = await call('/reset', env);
    expect(resetRes.status).toBe(200);
    const resetBody = (await resetRes.json()) as { data: { counts: Record<string, number> } };
    // The Postgres side of /reset's count: 0 rows there in object-only mode,
    // the object-mode cleanup ran separately.
    expect(resetBody.data.counts.mailMessages).toBe(0);

    expect(await store.mailbox(seeded.data.accountId).getMessage(seeded.data.id)).toBeNull();
  });
});
