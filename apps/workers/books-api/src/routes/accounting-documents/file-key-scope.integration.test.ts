/**
 * A document's fileKey comes from the client: it must be one of this
 * workspace's uploads when the document is created, and OCR re-checks it
 * before reading the object (TASK-620).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingDocumentsRoutes } from './index';
import { AccountingOcrError, isOwnDocumentKey, processDocumentOcr } from '../../services/accounting-ocr';
import type { Env } from '../../types';

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return {
    ...actual,
    // The master lookup: org_test_default is workspace ws_mine.
    getWorkspaceForOrg: vi.fn(async (_env: unknown, orgId: string) => {
      if (orgId === 'org_test_default') return { id: 'ws_mine' };
      throw new Error('unknown org');
    }),
  };
});

const ORG = 'org_test_default'; // the harness's workspaceId
const OWN_KEY = `workspaces/${ORG}/accounting/1_abc/receipt.png`;
const FOREIGN_KEY = 'workspaces/org_other/accounting/1_abc/receipt.png';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 180_000);

const create = (fileKey: string) =>
  createTestApp('/api/accounting-documents', accountingDocumentsRoutes, {
    context: { permissions: permissions('invoices:create'), tenantDb: db },
  }).request('/api/accounting-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'receipt.png', fileKey, mimeType: 'image/png' }),
  });

describe('POST /api/accounting-documents', () => {
  it("creates a document for one of this workspace's uploads", async () => {
    const res = await create(OWN_KEY);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, data.id));
    expect(row?.fileKey).toBe(OWN_KEY);
  });

  it.each([FOREIGN_KEY, 'workspaces/org_test_default/../org_other/x.png', 'docs/x.png'])(
    'refuses the key %s',
    async (fileKey) => {
      const res = await create(fileKey);
      expect(res.status).toBe(400);
      const rows = await db.select().from(schema.documents).where(eq(schema.documents.fileKey, fileKey));
      expect(rows).toHaveLength(0);
    },
  );
});

describe('OCR key check', () => {
  it('accepts org-keyed uploads and inbox mail keyed by the master workspace id', async () => {
    const env = {} as Env;
    expect(await isOwnDocumentKey(env, OWN_KEY, ORG)).toBe(true);
    expect(await isOwnDocumentKey(env, 'workspaces/ws_mine/accounting/inbox/e1/a.png', ORG)).toBe(true);
    expect(await isOwnDocumentKey(env, FOREIGN_KEY, ORG)).toBe(false);
    expect(await isOwnDocumentKey(env, 'workspaces/ws_other/accounting/inbox/e1/a.png', ORG)).toBe(false);
    // An org the master DB doesn't know only gets its own prefix.
    expect(await isOwnDocumentKey(env, OWN_KEY.replace(ORG, 'org_unknown'), 'org_unknown')).toBe(true);
    expect(await isOwnDocumentKey(env, 'workspaces/ws_mine/a.png', 'org_unknown')).toBe(false);
  });

  it("never reads another workspace's object, even when it exists", async () => {
    const get = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
    const env = { PRIVATE_STORAGE: { get } } as unknown as Env;
    const run = processDocumentOcr(env, {
      fileKey: FOREIGN_KEY,
      mimeType: 'image/png',
      workspaceId: ORG,
      userId: 'user_test_default',
      documentId: 'doc_x',
      metering: null,
    });
    await expect(run).rejects.toBeInstanceOf(AccountingOcrError);
    await expect(run).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(get).not.toHaveBeenCalled();
  });
});
