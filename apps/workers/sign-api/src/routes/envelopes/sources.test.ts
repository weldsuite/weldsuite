/**
 * DB-backed tests for phase 5: requests started from WeldDrive and the CRM,
 * and the signed PDF filed back.
 *
 * What must not regress:
 *   1. A request only starts from a file or record the member may read (CRM
 *      permission, Drive access); anything else reads as missing.
 *   2. A Drive PDF is copied in only when the member may open it and it is
 *      this workspace's object; the signed copy only goes to a folder the
 *      member may add files to.
 *   3. Filing puts the signed PDF in the chosen folder, or in the sender's own
 *      restricted `WeldSign/<year>` (never another member's), on the CRM
 *      record with a note, and does it once.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SignDocumentDto, SignEnvelopeDetail, SignRecipientSuggestion } from '@weldsuite/app-api-client/schemas/weldsign';
import envelopesRoutes from './index';
import { fileSignedPdf } from '../../services/filing';
import type { Env } from '../../types';

const BASE = '/api/sign/envelopes';
const ORG = 'org_sign_sources';
const SIGN = ['sign_envelopes:read', 'sign_envelopes:create', 'sign_envelopes:update'];
const CRM = ['companies:read', 'people:read', 'opportunities:read'];

let db: Database;
let pdfBytes: Uint8Array;

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array | ArrayBuffer) {
      objects.set(key, new Uint8Array(value));
      return {};
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const storage = memoryBucket();

function app(grants: string[] = [...SIGN, ...CRM, 'files:read'], userId = 'user_alice') {
  return createTestApp(BASE, envelopesRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, workspaceId: ORG, orgId: ORG },
    env: { PRIVATE_STORAGE: storage.bucket },
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const ids = {
  acme: 'cmp_acme',
  ann: 'per_ann',
  bob: 'per_bob',
  carl: 'per_carl',
  deal: 'opp_deal',
  contracts: 'fld_contracts',
  bobsPrivate: 'fld_bob_private',
  nda: 'fil_nda',
  secret: 'fil_secret',
  notes: 'fil_notes',
  foreign: 'fil_foreign',
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  pdfBytes = await doc.save();

  await db.insert(schema.companies).values({ id: ids.acme, name: 'Acme', displayName: 'Acme' });
  await db.insert(schema.people).values([
    { id: ids.ann, displayName: 'Ann de Vries', email: 'Ann@Acme.test', title: 'Director' },
    { id: ids.bob, displayName: 'Bob without email' },
    { id: ids.carl, displayName: 'Carl', email: 'carl@acme.test' },
  ]);
  await db.insert(schema.personCompanies).values([
    { id: generateId('pc'), personId: ids.ann, companyId: ids.acme },
    { id: generateId('pc'), personId: ids.bob, companyId: ids.acme },
  ]);
  await db.insert(schema.crmOpportunities).values({
    id: ids.deal,
    name: 'Big deal',
    customerId: ids.acme,
    ownerId: 'user_alice',
    primaryContactId: ids.carl,
    personIds: [ids.ann],
  });

  await db.insert(schema.folders).values([
    { id: ids.contracts, name: 'Contracts', createdById: 'user_alice', generalAccess: 'workspace_edit' },
    { id: ids.bobsPrivate, name: 'Bob only', createdById: 'user_bob', generalAccess: 'restricted' },
  ]);
  const file = (id: string, name: string, key: string, extra: Record<string, unknown> = {}) => ({
    id,
    fileName: name,
    mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
    fileSize: pdfBytes.byteLength,
    storagePath: key,
    fileKey: key,
    uploadedById: 'user_alice',
    ...extra,
  });
  await db.insert(schema.files).values([
    file(ids.nda, 'NDA.pdf', `workspaces/${ORG}/drive/nda.pdf`, { folderId: ids.contracts }),
    file(ids.secret, 'Secret.pdf', `workspaces/${ORG}/drive/secret.pdf`, { uploadedById: 'user_bob', generalAccess: 'restricted' }),
    file(ids.notes, 'notes.txt', `workspaces/${ORG}/drive/notes.txt`),
    file(ids.foreign, 'Theirs.pdf', 'workspaces/org_someone_else/x.pdf'),
  ]);
  for (const key of [`workspaces/${ORG}/drive/nda.pdf`, `workspaces/${ORG}/drive/secret.pdf`, 'workspaces/org_someone_else/x.pdf']) {
    await storage.bucket.put(key, pdfBytes);
  }
}, 60_000);

describe('starting a request from the CRM', () => {
  it('needs a record the member may read', async () => {
    const res = await app().request(BASE, json({ title: 'Contract for Acme', source: { entityType: 'company', entityId: ids.acme } }));
    expect(res.status).toBe(201);
    expect((await data<SignEnvelopeDetail>(res)).source).toEqual({ entityType: 'company', entityId: ids.acme, name: 'Acme' });

    expect((await app(SIGN).request(BASE, json({ title: 'x', source: { entityType: 'company', entityId: ids.acme } }))).status).toBe(404);
    expect((await app().request(BASE, json({ title: 'x', source: { entityType: 'person', entityId: 'per_gone' } }))).status).toBe(404);
  });

  it('suggests the record’s people who have an email', async () => {
    const suggest = async (entityType: string, entityId: string, grants?: string[]) => {
      const draft = await data<SignEnvelopeDetail>(await app().request(BASE, json({ title: 'x', source: { entityType, entityId } })));
      return data<SignRecipientSuggestion[]>(await app(grants).request(`${BASE}/${draft.id}/recipients/suggestions`));
    };
    expect(await suggest('company', ids.acme)).toEqual([{ personId: ids.ann, name: 'Ann de Vries', email: 'ann@acme.test', title: 'Director' }]);
    expect((await suggest('opportunity', ids.deal)).map((s) => s.email).sort()).toEqual(['ann@acme.test', 'carl@acme.test']);
    expect(await suggest('person', ids.carl)).toEqual([expect.objectContaining({ personId: ids.carl })]);
    // Without CRM access the record's people stay out of view.
    expect(await suggest('company', ids.acme, SIGN)).toEqual([]);
  });
});

describe('starting a request from WeldDrive', () => {
  it('copies in a PDF the member may open, and files the signed copy next to it', async () => {
    const res = await app().request(BASE, json({ title: 'NDA', source: { entityType: 'file', entityId: ids.nda } }));
    const draft = await data<SignEnvelopeDetail>(res);
    expect(draft).toMatchObject({ source: { entityType: 'file', name: 'NDA.pdf' }, fileBackFolderId: ids.contracts });

    const added = await app().request(`${BASE}/${draft.id}/documents/from-drive`, json({ fileId: ids.nda }));
    expect(added.status).toBe(201);
    const doc = await data<SignDocumentDto>(added);
    expect(doc).toMatchObject({ name: 'NDA.pdf', pageCount: 1 });
    const [row] = await db.select().from(schema.signDocuments).where(eq(schema.signDocuments.id, doc.id));
    expect(row!.storageKey).toContain(`/weldsign/${draft.id}/`);

    // Someone else's restricted file, another workspace's object, a text file, or no files:read.
    const from = (fileId: string, grants?: string[]) => app(grants).request(`${BASE}/${draft.id}/documents/from-drive`, json({ fileId }));
    expect((await from(ids.secret)).status).toBe(404);
    expect((await from(ids.foreign)).status).toBe(404);
    expect((await from(ids.notes)).status).toBe(400);
    expect((await from(ids.nda, [...SIGN])).status).toBe(403);
    expect((await app().request(BASE, json({ title: 'x', source: { entityType: 'file', entityId: ids.secret } }))).status).toBe(404);
  });

  it('only files the signed copy where the member may add files', async () => {
    expect((await app().request(BASE, json({ title: 'x', fileBackFolderId: ids.bobsPrivate }))).status).toBe(400);
    const draft = await data<SignEnvelopeDetail>(await app().request(BASE, json({ title: 'x' })));
    expect((await app().request(`${BASE}/${draft.id}`, json({ fileBackFolderId: ids.bobsPrivate }, 'PATCH'))).status).toBe(400);
    expect(await data<SignEnvelopeDetail>(await app().request(`${BASE}/${draft.id}`, json({ fileBackFolderId: ids.contracts }, 'PATCH')))).toMatchObject({
      fileBackFolderId: ids.contracts,
    });
  });
});

describe('filing the signed PDF back', () => {
  async function completed(values: Partial<typeof schema.signEnvelopes.$inferInsert>) {
    const id = generateId('sgn');
    const key = `workspaces/${ORG}/weldsign/${id}/final.pdf`;
    await storage.bucket.put(key, pdfBytes);
    await db.insert(schema.signEnvelopes).values({
      id,
      title: 'Service agreement',
      senderUserId: 'user_alice',
      status: 'completed',
      finalStorageKey: key,
      finalSha256: 'f'.repeat(64),
      completedAt: new Date('2026-11-02T10:00:00Z'),
      ...values,
    });
    await db.insert(schema.signRecipients).values({ id: generateId('sgr'), envelopeId: id, role: 'signer', name: 'Ann de Vries', email: 'ann@acme.test', status: 'signed' });
    return id;
  }
  const ctx = () => ({ env: {} as Env, db, bucket: storage.bucket, clerkOrgId: ORG });
  const file = async (id: string) => (await db.select().from(schema.files).where(eq(schema.files.id, id)))[0]!;
  const folder = async (id: string) => (await db.select().from(schema.folders).where(eq(schema.folders.id, id)))[0]!;

  it('goes to the sender’s own WeldSign/<year>, onto the company, with a note — once', async () => {
    const envelopeId = await completed({ source: { entityType: 'company', entityId: ids.acme } });
    const filing = (await fileSignedPdf(ctx(), envelopeId))!;

    const year = await folder(filing.driveFolderId!);
    expect(year).toMatchObject({ name: '2026', createdById: 'user_alice', generalAccess: 'restricted' });
    expect(await folder(year.parentId!)).toMatchObject({ name: 'WeldSign', parentId: null, createdById: 'user_alice', generalAccess: 'restricted' });
    const driveCopy = await file(filing.driveFileId!);
    expect(driveCopy).toMatchObject({ fileName: 'Service agreement (signed).pdf', folderId: year.id, uploadedById: 'user_alice', bucket: 'private', entityType: null });
    expect(storage.objects.has(driveCopy.fileKey!)).toBe(true);
    expect(await file(filing.recordFileId!)).toMatchObject({ entityType: 'company', entityId: ids.acme, folderId: null });
    expect(filing).toMatchObject({ recordType: 'company', recordId: ids.acme });
    const [note] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, filing.activityId!));
    expect(note).toMatchObject({ type: 'note', subject: 'Signed: Service agreement', customerId: ids.acme, status: 'completed', assignedToId: 'user_alice' });
    expect(note!.description).toContain('Ann de Vries');

    // Once: a second run finds the filing and adds nothing.
    const before = await db.select({ id: schema.files.id }).from(schema.files);
    expect(await fileSignedPdf(ctx(), envelopeId)).toEqual(filing);
    expect(await db.select({ id: schema.files.id }).from(schema.files)).toHaveLength(before.length);
    // The sender sees where it went.
    expect((await data<SignEnvelopeDetail>(await app().request(`${BASE}/${envelopeId}`))).filing).toEqual(filing);
  });

  it('uses the chosen folder, files an opportunity on its company, and never shares a sender’s folder', async () => {
    const chosen = (await fileSignedPdf(ctx(), await completed({ source: { entityType: 'opportunity', entityId: ids.deal }, fileBackFolderId: ids.contracts })))!;
    expect(chosen).toMatchObject({ driveFolderId: ids.contracts, recordType: 'company', recordId: ids.acme });
    const [note] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, chosen.activityId!));
    expect(note).toMatchObject({ opportunityId: ids.deal, relatedTo: 'opportunity' });

    // Bob's own request gets Bob's own WeldSign folder, not Alice's.
    const bobs = (await fileSignedPdf(ctx(), await completed({ senderUserId: 'user_bob' })))!;
    expect(await folder(bobs.driveFolderId!)).toMatchObject({ createdById: 'user_bob' });
    const roots = await db.select().from(schema.folders).where(and(eq(schema.folders.name, 'WeldSign')));
    expect(roots.map((r) => r.createdById).sort()).toEqual(['user_alice', 'user_bob']);
    expect(bobs).toMatchObject({ recordFileId: null, activityId: null });
  });
});
