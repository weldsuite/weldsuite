/**
 * DB-backed tests for /api/sign/envelopes (phase 1: drafts).
 *
 * What must not regress:
 *   1. A member without `sign_envelopes:manage` cannot see, change or delete
 *      someone else's envelope: it reads as 404, not 403.
 *   2. Only PDFs WeldSign can work with are stored, with their page geometry
 *      and SHA-256, in the private bucket under the workspace prefix.
 *   3. Fields are checked against the envelope's documents and recipients:
 *      no field off the page, on a missing page, or for a copy recipient.
 *   4. Access codes are stored as a keyed hash and never returned.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument, degrees } from 'pdf-lib';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SignDocumentDto, SignEnvelopeDetail, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import envelopesRoutes from './index';
import { codeHash, sha256Hex } from '@weldsuite/sign-domain/hash';

const BASE = '/api/sign/envelopes';
const WORKSPACE = 'org_sign_test';
const SECRET = 'envelope-test-secret';
const ALL = ['sign_envelopes:read', 'sign_envelopes:create', 'sign_envelopes:update', 'sign_envelopes:delete'];

let db: Database;

/** In-memory stand-in for the private bucket. */
function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array) {
      objects.set(key, new Uint8Array(value));
      return {};
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream() } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const storage = memoryBucket();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(grants: string[] = ALL, userId = 'user_alice') {
  return createTestApp(BASE, envelopesRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, orgId: WORKSPACE },
    env: { PRIVATE_STORAGE: storage.bucket, SIGN_SESSION_SECRET: SECRET },
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function pdf(pages: Array<[number, number, number?]> = [[595, 842]]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h, rotation] of pages) {
    const page = doc.addPage([w, h]);
    if (rotation) page.setRotation(degrees(rotation));
  }
  return doc.save();
}

function upload(bytes: Uint8Array, name = 'contract.pdf'): RequestInit {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'application/pdf' }));
  return { method: 'POST', body: form };
}

async function createDraft(title = 'Service agreement', userId = 'user_alice'): Promise<SignEnvelopeDetail> {
  const res = await app(ALL, userId).request(BASE, json({ title }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: SignEnvelopeDetail }).data;
}

describe('envelopes', () => {
  it('creates a draft with the sender and the default reminders, and records the created event', async () => {
    const draft = await createDraft();
    expect(draft).toMatchObject({ title: 'Service agreement', status: 'draft', senderUserId: 'user_alice', canEdit: true });
    expect(draft.reminderAfterDays).toBe(3);
    const events = await db.select().from(schema.signEvents).where(eq(schema.signEvents.envelopeId, draft.id));
    expect(events.map((e) => e.type)).toEqual(['created']);
  });

  it('lists only the caller’s own envelopes unless they manage WeldSign', async () => {
    const mine = await createDraft('Mine', 'user_list_a');
    const theirs = await createDraft('Theirs', 'user_list_b');

    const own = await app(['sign_envelopes:read'], 'user_list_a').request(`${BASE}?folder=drafts`);
    const ownIds = ((await own.json()) as { data: { id: string }[] }).data.map((e) => e.id);
    expect(ownIds).toContain(mine.id);
    expect(ownIds).not.toContain(theirs.id);

    const admin = await app(['sign_envelopes:read', 'sign_envelopes:manage'], 'user_list_a').request(`${BASE}?folder=drafts`);
    const adminIds = ((await admin.json()) as { data: { id: string }[] }).data.map((e) => e.id);
    expect(adminIds).toEqual(expect.arrayContaining([mine.id, theirs.id]));
  });

  it('hides someone else’s envelope as a 404', async () => {
    const draft = await createDraft('Private', 'user_owner');
    const other = app(ALL, 'user_other');
    expect((await other.request(`${BASE}/${draft.id}`)).status).toBe(404);
    expect((await other.request(`${BASE}/${draft.id}`, json({ title: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await other.request(`${BASE}/${draft.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('updates draft settings', async () => {
    const draft = await createDraft();
    const res = await app().request(`${BASE}/${draft.id}`, json({ title: 'Renamed', signingOrderEnabled: true, reminderAfterDays: null }, 'PATCH'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: SignEnvelopeDetail };
    expect(data).toMatchObject({ title: 'Renamed', signingOrderEnabled: true, reminderAfterDays: null });
  });

  it('refuses to change an envelope that is no longer a draft', async () => {
    const draft = await createDraft();
    await db.update(schema.signEnvelopes).set({ status: 'sent' }).where(eq(schema.signEnvelopes.id, draft.id));
    expect((await app().request(`${BASE}/${draft.id}`, json({ title: 'x' }, 'PATCH'))).status).toBe(409);
    expect((await app().request(`${BASE}/${draft.id}`, { method: 'DELETE' })).status).toBe(409);
  });
});

describe('documents', () => {
  it('stores a PDF with its pages and hash, serves it back and removes it', async () => {
    const draft = await createDraft();
    const bytes = await pdf([
      [595, 842],
      [842, 595],
      [595, 842, 90],
    ]);
    const res = await app().request(`${BASE}/${draft.id}/documents`, upload(bytes, 'folder/Contract'));
    expect(res.status).toBe(201);
    const doc = ((await res.json()) as { data: SignDocumentDto }).data;
    expect(doc.name).toBe('Contract.pdf');
    expect(doc.pageCount).toBe(3);
    expect(doc.pageSizes).toEqual([
      { width: 595, height: 842 },
      { width: 842, height: 595 },
      { width: 842, height: 595, rotation: 90 },
    ]);
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...storage.objects.keys()]).toContain(`workspaces/${WORKSPACE}/weldsign/${draft.id}/documents/${doc.id}.pdf`);

    const content = await app(['sign_envelopes:read']).request(`${BASE}/${draft.id}/documents/${doc.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('Content-Type')).toBe('application/pdf');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);

    expect((await app().request(`${BASE}/${draft.id}/documents/${doc.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(storage.objects.has(`workspaces/${WORKSPACE}/weldsign/${draft.id}/documents/${doc.id}.pdf`)).toBe(false);
  });

  it('rejects a file that is not a PDF', async () => {
    const draft = await createDraft();
    const res = await app().request(`${BASE}/${draft.id}/documents`, upload(new TextEncoder().encode('hello'), 'notes.pdf'));
    expect(res.status).toBe(400);
  });

  it('reorders documents', async () => {
    const draft = await createDraft();
    const a = ((await (await app().request(`${BASE}/${draft.id}/documents`, upload(await pdf(), 'a.pdf'))).json()) as { data: SignDocumentDto }).data;
    const b = ((await (await app().request(`${BASE}/${draft.id}/documents`, upload(await pdf(), 'b.pdf'))).json()) as { data: SignDocumentDto }).data;
    expect([a.position, b.position]).toEqual([0, 1]);
    const res = await app().request(`${BASE}/${draft.id}/documents/order`, json({ documentIds: [b.id, a.id] }, 'PUT'));
    expect(((await res.json()) as { data: SignDocumentDto[] }).data.map((d) => d.name)).toEqual(['b.pdf', 'a.pdf']);
    expect((await app().request(`${BASE}/${draft.id}/documents/order`, json({ documentIds: [b.id] }, 'PUT'))).status).toBe(400);
  });
});

describe('recipients and fields', () => {
  async function draftWithDoc() {
    const draft = await createDraft();
    const doc = ((await (await app().request(`${BASE}/${draft.id}/documents`, upload(await pdf()))).json()) as { data: SignDocumentDto }).data;
    const add = async (body: Record<string, unknown>) => {
      const res = await app().request(`${BASE}/${draft.id}/recipients`, json(body));
      return { status: res.status, data: ((await res.json()) as { data: SignRecipientDto }).data };
    };
    return { draft, doc, add };
  }

  it('adds recipients in order, hashes access codes and refuses duplicates', async () => {
    const { add } = await draftWithDoc();
    const first = await add({ name: 'Ann', email: 'Ann@Example.com' });
    const second = await add({ name: 'Bob', email: 'bob@example.com', authMode: 'access_code', accessCode: '4821' });
    expect(first.data).toMatchObject({ email: 'ann@example.com', role: 'signer', routingOrder: 1, authMode: 'link', hasAccessCode: false });
    expect(second.data).toMatchObject({ routingOrder: 2, hasAccessCode: true });
    expect(JSON.stringify(second.data)).not.toContain('4821');
    const [row] = await db.select().from(schema.signRecipients).where(eq(schema.signRecipients.id, second.data.id));
    // Keyed and bound to the recipient, never a plain hash of a short code.
    expect(row!.accessCodeHash).toBe(await codeHash(SECRET, second.data.id, '4821'));
    expect(row!.accessCodeHash).not.toBe(await sha256Hex('4821'));

    expect((await add({ name: 'Ann again', email: 'ann@example.com' })).status).toBe(400);
    expect((await add({ name: 'No code', email: 'c@example.com', authMode: 'access_code' })).status).toBe(400);
  });

  it('saves fields and keeps their ids, and refuses fields that do not fit', async () => {
    const { draft, doc, add } = await draftWithDoc();
    const signer = (await add({ name: 'Ann', email: 'ann@example.com' })).data;
    const cc = (await add({ name: 'Carl', email: 'carl@example.com', role: 'cc' })).data;
    const field = { documentId: doc.id, recipientId: signer.id, type: 'signature', page: 0, x: 50, y: 700, width: 160, height: 48, required: true };

    const save = (fields: unknown[]) => app().request(`${BASE}/${draft.id}/fields`, json({ fields }, 'PUT'));
    const res = await save([field]);
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { data: SignFieldDto[] }).data;
    expect(saved).toHaveLength(1);

    const again = ((await (await save([{ ...saved[0], x: 60 }])).json()) as { data: SignFieldDto[] }).data;
    expect(again[0]).toMatchObject({ id: saved[0]!.id, x: 60 });

    // An id from another envelope is never taken over: the field gets a new id,
    // the save succeeds, and the other envelope keeps its field.
    const other = await draftWithDoc();
    const otherSigner = (await other.add({ name: 'Zed', email: 'zed@example.com' })).data;
    const otherSaved = (
      (await (
        await app().request(
          `${BASE}/${other.draft.id}/fields`,
          json({ fields: [{ ...field, documentId: other.doc.id, recipientId: otherSigner.id }] }, 'PUT'),
        )
      ).json()) as { data: SignFieldDto[] }
    ).data;
    const stolen = await save([{ ...field, id: otherSaved[0]!.id }]);
    expect(stolen.status).toBe(200);
    const mine = ((await stolen.json()) as { data: SignFieldDto[] }).data;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).not.toBe(otherSaved[0]!.id);
    const theirs = await db.select().from(schema.signFields).where(eq(schema.signFields.envelopeId, other.draft.id));
    expect(theirs.map((f) => f.id)).toEqual([otherSaved[0]!.id]);

    expect((await save([{ ...field, x: 500 }])).status).toBe(400); // off the right edge
    expect((await save([{ ...field, page: 1 }])).status).toBe(400); // no page 2
    expect((await save([{ ...field, recipientId: cc.id }])).status).toBe(400); // copy recipient
  });

  it('drops a recipient’s fields when they are removed or become a copy recipient', async () => {
    const { draft, doc, add } = await draftWithDoc();
    const ann = (await add({ name: 'Ann', email: 'ann@example.com' })).data;
    const bob = (await add({ name: 'Bob', email: 'bob@example.com' })).data;
    const box = { documentId: doc.id, type: 'initials', page: 0, x: 10, y: 10, width: 64, height: 40, required: true };
    await app().request(`${BASE}/${draft.id}/fields`, json({ fields: [{ ...box, recipientId: ann.id }, { ...box, recipientId: bob.id }] }, 'PUT'));

    await app().request(`${BASE}/${draft.id}/recipients/${ann.id}`, json({ role: 'cc' }, 'PATCH'));
    await app().request(`${BASE}/${draft.id}/recipients/${bob.id}`, { method: 'DELETE' });
    const detail = ((await (await app().request(`${BASE}/${draft.id}`)).json()) as { data: SignEnvelopeDetail }).data;
    expect(detail.fields).toEqual([]);
    expect(detail.recipientList.map((r) => r.role)).toEqual(['cc']);
  });

  it('deletes a draft with its rows and files', async () => {
    const { draft, doc, add } = await draftWithDoc();
    await add({ name: 'Ann', email: 'ann@example.com' });
    const key = `workspaces/${WORKSPACE}/weldsign/${draft.id}/documents/${doc.id}.pdf`;
    expect(storage.objects.has(key)).toBe(true);
    expect((await app().request(`${BASE}/${draft.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(storage.objects.has(key)).toBe(false);
    expect(await db.select().from(schema.signRecipients).where(eq(schema.signRecipients.envelopeId, draft.id))).toEqual([]);
    expect((await app().request(`${BASE}/${draft.id}`)).status).toBe(404);
  });
});
