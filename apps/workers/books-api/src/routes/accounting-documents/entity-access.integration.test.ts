/**
 * Per-entity access in the document inbox (ADR SEC-015; pglite, the real
 * `legalEntityContext()` with real permission resolution, mounted the way
 * index.ts mounts it):
 *
 *  (a) a document is filed under the entity of the bill created from it, or of
 *      the record it is linked to;
 *  (b) a member who is not listed on a restricted entity no longer lists or
 *      counts the documents filed under it, and gets a 404 for one by id,
 *      while the unfiled inbox stays theirs;
 *  (c) that member cannot file a document under the restricted entity, nor
 *      move one out of it, by linking it or creating a bill from it.
 *
 * Every request goes through `createTestApp`, one app per member with that
 * member's workspace permissions resolved from the database, so conformance
 * mode runs it on the Rust backend too.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { legalEntityContext } from '@weldsuite/core-domain/legal-entities';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { accountingDocumentsRoutes } from './index';
import { billsRoutes } from '../bills';

const USERS = ['u_admin', 'u_member'] as const;
type User = (typeof USERS)[number];

let db: Database;
const memberPermissions = new Map<User, ResolvedPermissions>();
const apps = new Map<User, ReturnType<typeof createTestApp>>();

/** The routes under test as index.ts mounts them: legalEntityContext on /api/*, then the routers. */
function booksRoutes() {
  const books = new Hono<{ Bindings: Env; Variables: Variables }>();
  books.use('/api/*', legalEntityContext({ app: 'weldbooks', scoped: true }));
  books.route('/api/accounting-documents', accountingDocumentsRoutes);
  books.route('/api/bills', billsRoutes);
  return books;
}

/** The member's test app, made on first use (inside a test, where conformance mode records it). */
function appFor(user: User) {
  let app = apps.get(user);
  if (!app) {
    const permissions = memberPermissions.get(user);
    if (!permissions) throw new Error(`no permissions resolved for ${user}`);
    app = createTestApp('/', booksRoutes(), { context: { userId: user, tenantDb: db, permissions } });
    apps.set(user, app);
  }
  return app;
}

async function call(user: User, method: string, path: string, opts: { entity?: string; body?: unknown } = {}) {
  const res = await appFor(user).request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.entity ? { 'x-legal-entity-id': opts.entity } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (text ? JSON.parse(text) : {}) as { data?: any; error?: { message: string } };
  return { status: res.status, ...json };
}

const listed = async (user: User, entity?: string) => {
  const res = await call(user, 'GET', '/api/accounting-documents', { entity });
  expect(res.status).toBe(200);
  return (res.data as Array<{ id: string }>).map((d) => d.id).sort();
};

const counted = async (user: User, entity?: string) => {
  const res = await call(user, 'GET', '/api/accounting-documents/stats', { entity });
  expect(res.status).toBe(200);
  return Object.fromEntries((res.data as Array<{ status: string; count: number }>).map((s) => [s.status, s.count]));
};

async function documentRow(id: string) {
  const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
  return row;
}

const billBody = (extra: Record<string, unknown> = {}) => ({
  contactId: 'pty_doc_vendor',
  contactName: 'Supplier BV',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  currency: 'EUR',
  ...extra,
});

const file = (name: string) => `workspaces/org_test_default/accounting/${name}`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_doc_admin', userId: 'u_admin', role: 'ADMIN' },
    { id: 'wm_doc_member', userId: 'u_member', role: 'MEMBER' },
  ]);
  await db.insert(schema.legalEntities).values([
    { id: 'ent_open', name: 'Open BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', isDefault: true },
    { id: 'ent_secret', name: 'Secret BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', accessRestricted: true },
  ]);
  await db.insert(schema.accountingEntitySettings).values([{ entityId: 'ent_open' }, { entityId: 'ent_secret' }]);
  // u_admin is listed on the restricted entity, u_member is not.
  await db.insert(schema.legalEntityMembers).values({ id: 'lem_doc_admin', entityId: 'ent_secret', userId: 'u_admin', roleId: null });
  await db.insert(schema.parties).values({ id: 'pty_doc_vendor', displayName: 'Supplier BV', role: 'supplier' });
  // Uploads and emailed documents: in nobody's entity until they are linked.
  await db.insert(schema.documents).values([
    { id: 'doc_inbox', fileName: 'inbox.pdf', fileKey: file('inbox.pdf'), status: 'pending' },
    { id: 'doc_scan', fileName: 'scan.pdf', fileKey: file('scan.pdf'), status: 'processed' },
    { id: 'doc_upload', fileName: 'upload.pdf', fileKey: file('upload.pdf'), status: 'pending' },
    { id: 'doc_mine', fileName: 'mine.pdf', fileKey: file('mine.pdf'), status: 'pending' },
  ] as Array<typeof schema.documents.$inferInsert>);

  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  for (const user of USERS) memberPermissions.set(user, await resolveEffectivePermissions(queries, user));
}, 120_000);

let secretBill: string;

describe('filing a document under an entity', () => {
  it('files it under the entity of the bill created from it', async () => {
    const created = await call('u_admin', 'POST', '/api/bills', {
      entity: 'ent_secret',
      body: billBody({ sourceDocumentId: 'doc_scan' }),
    });
    expect(created.status).toBe(201);
    secretBill = created.data.id;
    const row = await documentRow('doc_scan');
    expect(row?.entityId).toBe('ent_secret');
    expect(row?.status).toBe('linked');
    expect(row?.linkedEntityId).toBe(secretBill);
  });

  it('files it under the entity of the record it is linked to', async () => {
    const linked = await call('u_admin', 'PATCH', '/api/accounting-documents/doc_upload/link', {
      entity: 'ent_secret',
      body: { linkedEntityType: 'bill', linkedEntityId: secretBill },
    });
    expect(linked.status).toBe(200);
    expect(linked.data).toEqual({ id: 'doc_upload', status: 'linked' });
    expect((await documentRow('doc_upload'))?.entityId).toBe('ent_secret');
  });
});

describe('a member who is not listed on a restricted entity', () => {
  it('does not list or count the documents filed under it, and keeps the unfiled inbox', async () => {
    for (const entity of [undefined, 'ent_open', 'ent_secret']) {
      const ids = await listed('u_member', entity);
      expect(ids).not.toContain('doc_scan');
      expect(ids).not.toContain('doc_upload');
    }
    expect(await listed('u_member', 'ent_open')).toEqual(['doc_inbox', 'doc_mine']);
    expect(await counted('u_member', 'ent_open')).toEqual({ pending: 2 });
    // An entity the member may not see resolves to none: nothing is listed.
    expect(await listed('u_member', 'ent_secret')).toEqual([]);
    expect(await counted('u_member', 'ent_secret')).toEqual({});
  });

  it('gets a 404 for one by id, whichever entity the header names', async () => {
    for (const entity of [undefined, 'ent_open', 'ent_secret']) {
      const res = await call('u_member', 'GET', '/api/accounting-documents/doc_scan', { entity });
      expect(res.status).toBe(404);
    }
    expect((await call('u_member', 'GET', '/api/accounting-documents/doc_inbox', { entity: 'ent_open' })).status).toBe(200);
  });

  it('cannot file a document under it by linking', async () => {
    const res = await call('u_member', 'PATCH', '/api/accounting-documents/doc_inbox/link', {
      entity: 'ent_open',
      body: { linkedEntityType: 'bill', linkedEntityId: secretBill },
    });
    expect(res.status).toBe(404);
    const row = await documentRow('doc_inbox');
    expect(row?.entityId).toBeNull();
    expect(row?.status).toBe('pending');
  });

  it('cannot move a document out of it by creating a bill from it', async () => {
    const res = await call('u_member', 'POST', '/api/bills', {
      entity: 'ent_open',
      body: billBody({ sourceDocumentId: 'doc_scan', billNumber: 'MOVE-1' }),
    });
    expect(res.status).toBe(404);
    const row = await documentRow('doc_scan');
    expect(row?.entityId).toBe('ent_secret');
    expect(row?.linkedEntityId).toBe(secretBill);
    const bills = await db.select({ id: schema.bills.id }).from(schema.bills).where(eq(schema.bills.billNumber, 'MOVE-1'));
    expect(bills).toEqual([]);
  });

  it('files an inbox document under their own entity, and still lists it there', async () => {
    const created = await call('u_member', 'POST', '/api/bills', { entity: 'ent_open', body: billBody() });
    expect(created.status).toBe(201);
    const linked = await call('u_member', 'PATCH', '/api/accounting-documents/doc_mine/link', {
      entity: 'ent_open',
      body: { linkedEntityType: 'bill', linkedEntityId: created.data.id },
    });
    expect(linked.status).toBe(200);
    expect((await documentRow('doc_mine'))?.entityId).toBe('ent_open');
    expect(await listed('u_member', 'ent_open')).toEqual(['doc_inbox', 'doc_mine']);
    expect(await counted('u_member', 'ent_open')).toEqual({ pending: 1, linked: 1 });
  });
});

describe('a member listed on the restricted entity', () => {
  it('lists its documents in that entity, and the unfiled ones in each', async () => {
    expect(await listed('u_admin', 'ent_secret')).toEqual(['doc_inbox', 'doc_scan', 'doc_upload']);
    expect(await counted('u_admin', 'ent_secret')).toEqual({ pending: 1, linked: 2 });
    expect(await listed('u_admin', 'ent_open')).toEqual(['doc_inbox', 'doc_mine']);
    expect((await call('u_admin', 'GET', '/api/accounting-documents/doc_scan', { entity: 'ent_secret' })).status).toBe(200);
  });
});
