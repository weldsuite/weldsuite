/**
 * DB-backed tests for /api/sign/templates (phase 4).
 *
 * What must not regress:
 *   1. A template is built like a draft (documents, fields) with named roles,
 *      unique per template; only signer roles get fields.
 *   2. `sign_templates:update` is what lets a member change one; with only
 *      `:read` they can open and use it, not edit it.
 *   3. Using a template makes a sendable draft: one recipient per role with
 *      the person given, fields mapped, PDFs copied to the draft's own keys.
 *      A missing role, a duplicate address or a missing access code is
 *      refused and leaves nothing behind.
 *   4. Deleting a template never touches the requests made from it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  SignDocumentDto,
  SignEnvelopeDetail,
  SignFieldDto,
  SignRecipientDto,
  SignTemplateSummary,
} from '@weldsuite/app-api-client/schemas/weldsign';
import templatesRoutes from './index';
import envelopesRoutes from '../envelopes';
import { sendProblem } from '../../services/sending';

const BASE = '/api/sign/templates';
const WORKSPACE = 'org_sign_templates';
const SECRET = 'template-test-secret';
const EDITOR = ['sign_templates:read', 'sign_templates:create', 'sign_templates:update', 'sign_templates:delete', 'sign_envelopes:read', 'sign_envelopes:create'];
const MEMBER = ['sign_templates:read', 'sign_envelopes:read', 'sign_envelopes:create'];

let db: Database;

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

function app(grants: string[] = EDITOR, base = BASE, routes = templatesRoutes) {
  return createTestApp(base, routes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', workspaceId: WORKSPACE, orgId: WORKSPACE },
    env: { PRIVATE_STORAGE: storage.bucket, SIGN_SESSION_SECRET: SECRET },
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

/** A template with one two-page PDF, Client and Director signing, an Office copy, and their fields. */
async function contractTemplate() {
  const editor = app();
  const template = await data<SignEnvelopeDetail>(await editor.request(BASE, json({ title: 'Service agreement', message: 'Please sign.' })));
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  const form = new FormData();
  form.append('file', new File([await doc.save()], 'agreement.pdf', { type: 'application/pdf' }));
  const pdf = await data<SignDocumentDto>(await editor.request(`${BASE}/${template.id}/documents`, { method: 'POST', body: form }));
  const role = async (body: Record<string, unknown>) => data<SignRecipientDto>(await editor.request(`${BASE}/${template.id}/roles`, json(body)));
  const client = await role({ roleName: 'Client', authMode: 'email_code' });
  const director = await role({ roleName: 'Director', authMode: 'access_code', name: 'Gert', email: 'gert@example.com', locale: 'nl' });
  const office = await role({ roleName: 'Office', role: 'cc' });
  const field = (recipientId: string, type: string, page: number) => ({
    documentId: pdf.id, recipientId, type, page, x: 50, y: 700, width: 160, height: 40, required: true,
  });
  const saved = await editor.request(
    `${BASE}/${template.id}/fields`,
    json({ fields: [field(client.id, 'signature', 0), field(client.id, 'date_signed', 0), field(director.id, 'signature', 1)] }, 'PUT'),
  );
  expect(saved.status).toBe(200);
  return { template, pdf, client, director, office };
}

describe('templates', () => {
  it('builds a template from documents, unique roles and signer fields', async () => {
    const { template, pdf, client, office } = await contractTemplate();
    const editor = app();
    expect(template).toMatchObject({ kind: 'template', status: 'draft', canEdit: true, isOwner: false, mySignerId: null });

    expect((await editor.request(`${BASE}/${template.id}/roles`, json({ roleName: 'client' }))).status).toBe(400);
    const copyField = { documentId: pdf.id, recipientId: office.id, type: 'signature', page: 0, x: 50, y: 50, width: 160, height: 40, required: true };
    expect((await editor.request(`${BASE}/${template.id}/fields`, json({ fields: [copyField] }, 'PUT'))).status).toBe(400);

    const detail = await data<SignEnvelopeDetail>(await editor.request(`${BASE}/${template.id}`));
    expect(detail.recipientList.map((r) => [r.roleName, r.role, r.name])).toEqual([
      ['Client', 'signer', null],
      ['Director', 'signer', 'Gert'],
      ['Office', 'cc', null],
    ]);
    expect(detail.fields).toHaveLength(3);
    expect(detail.fields.filter((f) => f.recipientId === client.id)).toHaveLength(2);

    // A copy role signs nothing: it opens by link alone, whatever was asked for.
    const witness = await data<SignRecipientDto>(await editor.request(`${BASE}/${template.id}/roles`, json({ roleName: 'Witness', role: 'cc', authMode: 'access_code' })));
    expect(witness.authMode).toBe('link');
    const signing = await editor.request(`${BASE}/${template.id}/roles/${witness.id}`, json({ role: 'signer', authMode: 'access_code' }, 'PATCH'));
    expect(await data<SignRecipientDto>(signing)).toMatchObject({ role: 'signer', authMode: 'access_code' });
    const demoted = await data<SignRecipientDto>(await editor.request(`${BASE}/${template.id}/roles/${witness.id}`, json({ role: 'cc' }, 'PATCH')));
    expect(demoted).toMatchObject({ role: 'cc', authMode: 'link' });
    expect((await editor.request(`${BASE}/${template.id}/roles/${witness.id}`, { method: 'DELETE' })).status).toBe(204);

    const listed = await data<SignTemplateSummary[]>(await editor.request(`${BASE}?search=service`));
    expect(listed.find((t) => t.id === template.id)).toMatchObject({ documentCount: 1, roles: [{ roleName: 'Client' }, { roleName: 'Director' }, { roleName: 'Office' }] });
    // Templates are not requests.
    const requests = await data<{ id: string }[]>(await app(EDITOR, '/api/sign/envelopes', envelopesRoutes).request('/api/sign/envelopes'));
    expect(requests.some((r) => r.id === template.id)).toBe(false);
  });

  it('lets a member with read access open and use a template, not change it', async () => {
    const { template } = await contractTemplate();
    const member = app(MEMBER);
    expect(await data<SignEnvelopeDetail>(await member.request(`${BASE}/${template.id}`))).toMatchObject({ canEdit: false });
    expect((await member.request(`${BASE}/${template.id}`, json({ title: 'Mine now' }, 'PATCH'))).status).toBe(403);
    expect((await member.request(`${BASE}/${template.id}/roles`, json({ roleName: 'Witness' }))).status).toBe(403);
    expect((await member.request(`${BASE}/${template.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await app(['sign_templates:read']).request(`${BASE}/${template.id}/use`, json({ recipients: [] }))).status).toBe(403);
  });

  it('makes a sendable draft with a person in every role', async () => {
    const { template, client, director, office } = await contractTemplate();
    const member = app(MEMBER);
    const use = (recipients: unknown[], extra: Record<string, unknown> = {}) =>
      member.request(`${BASE}/${template.id}/use`, json({ recipients, ...extra }));
    const ann = { roleId: client.id, name: 'Ann', email: 'ann@example.com' };
    const gert = { roleId: director.id, name: 'Gert', email: 'gert@example.com', accessCode: '4821' };
    const carl = { roleId: office.id, name: 'Carl', email: 'carl@example.com' };

    // A role left out, an address twice, no access code: refused, and nothing is left behind.
    const before = await db.select({ id: schema.signEnvelopes.id }).from(schema.signEnvelopes);
    expect((await use([ann, gert])).status).toBe(400);
    expect((await use([ann, { ...gert, email: 'ann@example.com' }, carl])).status).toBe(400);
    expect((await use([ann, { ...gert, accessCode: null }, carl])).status).toBe(400);
    expect(await db.select({ id: schema.signEnvelopes.id }).from(schema.signEnvelopes)).toHaveLength(before.length);

    const res = await use([ann, gert, carl], { title: 'Service agreement — Acme' });
    expect(res.status).toBe(201);
    const draft = await data<SignEnvelopeDetail>(res);
    expect(draft).toMatchObject({ kind: 'envelope', status: 'draft', title: 'Service agreement — Acme', message: 'Please sign.' });
    expect(draft.recipientList.map((r) => [r.roleName, r.name, r.email, r.authMode, r.locale, r.hasAccessCode])).toEqual([
      ['Client', 'Ann', 'ann@example.com', 'email_code', 'en', false],
      ['Director', 'Gert', 'gert@example.com', 'access_code', 'nl', true],
      ['Office', 'Carl', 'carl@example.com', 'link', 'en', false],
    ]);
    // Fields point at the draft's own document and people.
    const docIds = new Set(draft.documents.map((d) => d.id));
    const people = new Set(draft.recipientList.map((r) => r.id));
    expect(draft.fields).toHaveLength(3);
    expect(draft.fields.every((f: SignFieldDto) => docIds.has(f.documentId) && people.has(f.recipientId))).toBe(true);
    const [row] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, draft.id));
    expect(row!.templateId).toBe(template.id);
    expect(await sendProblem(db, draft.id)).toBeNull();

    // The PDF was copied; deleting the template leaves the request's copy alone.
    const [copy] = await db.select().from(schema.signDocuments).where(eq(schema.signDocuments.envelopeId, draft.id));
    expect(copy!.storageKey).toContain(`/weldsign/${draft.id}/`);
    expect(storage.objects.has(copy!.storageKey)).toBe(true);
    expect((await app().request(`${BASE}/${template.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app().request(`${BASE}/${template.id}`)).status).toBe(404);
    expect(storage.objects.has(copy!.storageKey)).toBe(true);
  });
});
