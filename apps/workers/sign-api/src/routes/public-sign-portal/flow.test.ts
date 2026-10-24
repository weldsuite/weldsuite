/**
 * The whole signing flow against pglite (tenant + master), an in-memory
 * bucket, KV and mail transport: a draft with two signers in order and a copy
 * recipient is sent, both sign through the portal routes, and the request is
 * finalized into one PDF with a certificate whose hash is recorded.
 *
 * Also: codes, consent, required fields, decline and expiry.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import type { SignDocumentDto, SignEnvelopeDetail, SignPortalEnvelope, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import envelopesRoutes from '../envelopes';
import { createSignPortalRoutes } from './index';
import { sendEnvelope } from '../../services/sending';
import { buildFinalPdf, notifyCompleted } from '../../services/finalize';
import { sha256Hex } from '../../services/hash';
import type { Env } from '../../types';

const mail = vi.hoisted(() => ({ transport: null as ReturnType<typeof memoryTransport> | null }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => mail.transport }));
// The guard needs mail-api's Durable Objects and the master DB; here it always allows.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>();
  return {
    ...actual,
    checkOutbound: vi.fn(async (_env: unknown, _db: unknown, input: { to: string[] }) => ({
      ledger: null,
      reservationId: null,
      sender: '',
      recipients: input.to,
      firstContact: [],
      mode: 'unavailable',
    })),
    commitOutbound: vi.fn(async () => undefined),
    releaseOutbound: vi.fn(async () => undefined),
  };
});

const ORG = 'org_flow';
const WS = 'ws_flow';
const SECRET = 'flow-test-secret';
const BASE = '/api/sign/envelopes';
const PORTAL = '/public/sign-portal';

let db: Database;
let master: MasterDatabase;

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      async put(key: string, value: Uint8Array) {
        objects.set(key, new Uint8Array(value));
        return {};
      },
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    } as unknown as R2Bucket,
  };
}

const storage = memoryBucket();
const kv = createMemoryKv();
const finalizeCalls: unknown[] = [];

function env(): Env {
  return {
    PRIVATE_STORAGE: storage.bucket,
    WORKSPACE_CACHE: kv,
    SIGN_SESSION_SECRET: SECRET,
    SIGN_PORTAL_URL: 'https://sign.test',
    ENVIRONMENT: 'test',
  } as unknown as Env;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(() => {
  mail.transport = memoryTransport();
  finalizeCalls.length = 0;
});

function member(grants: string[] = ['*']) {
  return createTestApp(BASE, envelopesRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_sender', workspaceId: ORG, orgId: ORG },
    env: { PRIVATE_STORAGE: storage.bucket } as Partial<Env>,
  });
}

function portal() {
  const routes = createSignPortalRoutes({
    master: () => master,
    workspace: async () => ({ id: WS, db, suspended: false }),
    finalize: async (_env, params) => {
      finalizeCalls.push(params);
    },
  });
  const app = new Hono<{ Bindings: Env }>();
  app.route(PORTAL, routes as never);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p.catch(() => undefined)), passThroughOnException: () => {}, props: {} };
  return {
    pending,
    request: (path: string, init: RequestInit = {}, session?: string) =>
      app.request(
        `${PORTAL}${path}`,
        { ...init, headers: { 'Content-Type': 'application/json', 'X-Signer-Ip': '203.0.113.9', 'User-Agent': 'FlowTest/1.0', ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(init.headers ?? {}) } },
        env() as never,
        executionCtx as never,
      ),
  };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const to = (m: { to: Array<string | { email: string }> }) => {
  const first = m.to[0]!;
  return typeof first === 'string' ? first : first.email;
};

/** Signing links in the mails sent so far, by recipient address. */
function linksByRecipient(): Map<string, string> {
  const out = new Map<string, string>();
  for (const sent of mail.transport!.sent) {
    const match = /https:\/\/sign\.test\/r\/([A-Za-z0-9_-]+)/.exec(sent.text ?? '');
    if (match) out.set(to(sent), match[1]!);
  }
  return out;
}

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const signature = { kind: 'drawn' as const, image: PNG };

async function draftWithTwoSigners(opts: { expiresAt?: string } = {}) {
  const app = member();
  const draft = await data<SignEnvelopeDetail>(await app.request(BASE, json({ title: 'Service agreement', message: 'Please sign.' })));
  // The sender's name and email come from workspace_members, which this tenant has no row for.
  await db.update(schema.signEnvelopes).set({ senderName: 'Gert', senderEmail: 'gert@example.com' }).where(eq(schema.signEnvelopes.id, draft.id));
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([842, 595]);
  const form = new FormData();
  form.append('file', new File([await doc.save()], 'agreement.pdf', { type: 'application/pdf' }));
  const pdf = await data<SignDocumentDto>(await app.request(`${BASE}/${draft.id}/documents`, { method: 'POST', body: form }));
  const add = async (body: Record<string, unknown>) => data<SignRecipientDto>(await app.request(`${BASE}/${draft.id}/recipients`, json(body)));
  const ann = await add({ name: 'Ann', email: 'ann@example.com', routingOrder: 1 });
  const bob = await add({ name: 'Bob', email: 'bob@example.com', routingOrder: 2, authMode: 'email_code' });
  const carl = await add({ name: 'Carl', email: 'carl@example.com', role: 'cc', routingOrder: 3 });
  await app.request(`${BASE}/${draft.id}`, json({ signingOrderEnabled: true }, 'PATCH'));
  const field = (recipientId: string, type: string, page: number, y: number, extra: Record<string, unknown> = {}) => ({
    documentId: pdf.id, recipientId, type, page, x: 50, y, width: 160, height: 40, required: true, ...extra,
  });
  await app.request(
    `${BASE}/${draft.id}/fields`,
    json(
      {
        fields: [
          field(ann.id, 'signature', 0, 700),
          field(ann.id, 'date_signed', 0, 650, { height: 22 }),
          field(ann.id, 'text', 0, 600, { height: 22, label: 'Job title' }),
          field(bob.id, 'signature', 1, 450),
          field(bob.id, 'checkbox', 1, 400, { width: 16, height: 16, label: 'I accept' }),
        ],
      },
      'PUT',
    ),
  );
  const [row] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, draft.id));
  const sent = await sendEnvelope(
    { env: env(), db, master, clerkOrgId: ORG, workspaceId: WS },
    row!,
    { userId: 'user_sender', name: 'Gert', email: 'gert@example.com' },
    opts.expiresAt,
  );
  return { envelope: sent, ann, bob, carl };
}

async function openAndConsent(p: ReturnType<typeof portal>, token: string): Promise<string> {
  const opened = await data<{ state: string; session: string }>(await p.request('/session', json({ token })));
  expect(opened.state).toBe('ready');
  expect((await p.request('/consent', json({ disclosureVersion: '2026-10-24' }), opened.session)).status).toBe(200);
  return opened.session;
}

describe('signing flow', () => {
  it('runs from send to a signed PDF with a certificate', async () => {
    const { envelope, ann, bob } = await draftWithTwoSigners();
    expect(envelope.status).toBe('sent');
    expect(envelope.expiresAt).not.toBeNull();

    // Signing order: only Ann is emailed at first.
    let links = linksByRecipient();
    expect([...links.keys()]).toEqual(['ann@example.com']);
    const p = portal();

    // Bob's turn has not come; a stranger's token is unknown.
    expect((await p.request('/session', json({ token: 'x'.repeat(43) }))).status).toBe(404);

    // Ann: no consent yet → refused; then consent, a missing required field, and success.
    const annOpen = await data<{ session: string }>(await p.request('/session', json({ token: links.get('ann@example.com') })));
    const view = await data<SignPortalEnvelope>(await p.request('/envelope', {}, annOpen.session));
    expect(view).toMatchObject({ mode: 'sign', recipient: { name: 'Ann', consented: false } });
    expect(view.fields.map((f) => f.type).sort()).toEqual(['date_signed', 'signature', 'text']);
    const textField = view.fields.find((f) => f.type === 'text')!;
    expect((await p.request('/complete', json({ values: [], signature }), annOpen.session)).status).toBe(409);
    await p.request('/consent', json({ disclosureVersion: '2026-10-24' }), annOpen.session);
    expect((await p.request('/complete', json({ values: [], signature }), annOpen.session)).status).toBe(400);
    const annRes = await p.request('/complete', json({ values: [{ fieldId: textField.id, value: 'Director' }], signature, timeZone: 'Europe/Amsterdam' }), annOpen.session);
    const annDone = await data<SignPortalEnvelope>(annRes);
    expect(annDone.mode).toBe('waiting');
    expect(annDone.fields.find((f) => f.type === 'text')?.value).toBe('Director');

    // Ann's document is now a working copy for Bob; Bob was emailed.
    expect([...storage.objects.keys()].some((k) => k.endsWith('.working.pdf'))).toBe(true);
    links = linksByRecipient();
    expect(links.has('bob@example.com')).toBe(true);

    // Bob needs the emailed code: a wrong one, then the right one.
    const bobToken = links.get('bob@example.com')!;
    const needsCode = await data<{ state: string; method: string; emailHint: string }>(await p.request('/session', json({ token: bobToken })));
    expect(needsCode).toMatchObject({ state: 'code_required', method: 'email_code', emailHint: 'b••@example.com' });
    const codeMail = mail.transport!.sent.find((m) => to(m) === 'bob@example.com' && /\b\d{6}\b/.test(m.subject));
    const code = /\b(\d{6})\b/.exec(codeMail!.subject)![1]!;
    const wrong = await p.request('/verify', json({ token: bobToken, code: code === '000000' ? '111111' : '000000' }));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string; details: { attemptsLeft: number } } }).error).toMatchObject({
      code: 'INVALID_CODE',
      details: { attemptsLeft: 4 },
    });
    const bobOpen = await data<{ state: string; session: string }>(await p.request('/verify', json({ token: bobToken, code })));
    expect(bobOpen.state).toBe('ready');
    await p.request('/consent', json({ disclosureVersion: '2026-10-24' }), bobOpen.session);
    const bobView = await data<SignPortalEnvelope>(await p.request('/envelope', {}, bobOpen.session));
    const box = bobView.fields.find((f) => f.type === 'checkbox')!;
    expect((await p.request('/complete', json({ values: [{ fieldId: box.id, value: 'false' }], signature }), bobOpen.session)).status).toBe(400);
    await p.request('/complete', json({ values: [{ fieldId: box.id, value: 'true' }], signature }), bobOpen.session);
    await Promise.all(p.pending);
    expect(finalizeCalls).toEqual([{ clerkOrgId: ORG, workspaceId: WS, envelopeId: envelope.id }]);

    // Finalize: one PDF (2 pages + certificate), hash recorded, everyone mailed.
    const ctx = { env: env(), db, bucket: storage.bucket, clerkOrgId: ORG, master };
    mail.transport = memoryTransport();
    const built = await buildFinalPdf(ctx, envelope.id);
    expect(built).not.toBeNull();
    const stored = storage.objects.get(built!.key)!;
    expect(await sha256Hex(stored)).toBe(built!.sha256);
    expect((await PDFDocument.load(stored)).getPageCount()).toBe(3);
    await notifyCompleted(ctx, master, WS, envelope.id);
    await notifyCompleted(ctx, master, WS, envelope.id); // idempotent
    const recipients = mail.transport.sent.map((m) => to(m)).sort();
    expect(recipients).toEqual(['ann@example.com', 'bob@example.com', 'carl@example.com', 'gert@example.com']);
    expect(mail.transport.sent.find((m) => to(m) === 'carl@example.com')?.attachments?.[0]?.contentType).toBe('application/pdf');

    const [done] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, envelope.id));
    expect(done).toMatchObject({ status: 'completed', finalSha256: built!.sha256 });
    const events = await db.select().from(schema.signEvents).where(eq(schema.signEvents.envelopeId, envelope.id));
    const types = events.map((e) => e.type);
    for (const t of ['created', 'sent', 'opened', 'code_failed', 'code_verified', 'consented', 'signed', 'completed', 'delivered']) {
      expect(types).toContain(t);
    }
    const signed = events.find((e) => e.type === 'signed' && e.recipientId === ann.id);
    expect(signed).toMatchObject({ ip: '203.0.113.9', userAgent: 'FlowTest/1.0' });

    // Ann can download the signed PDF with her session; a member too.
    const download = await p.request('/download', {}, annOpen.session);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer()).byteLength).toBe(stored.byteLength);
    expect((await member().request(`${BASE}/${envelope.id}/download`)).status).toBe(200);
    expect(bob.id).toBeTruthy();
  });

  it('closes the request for everyone when a signer declines', async () => {
    const { envelope } = await draftWithTwoSigners();
    const p = portal();
    const token = linksByRecipient().get('ann@example.com')!;
    const session = await openAndConsent(p, token);
    const after = await data<SignPortalEnvelope>(await p.request('/decline', json({ reason: 'Clause 4 is wrong.' }), session));
    expect(after).toMatchObject({ mode: 'closed', closedReason: 'declined' });
    await Promise.all(p.pending);
    const [row] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, envelope.id));
    expect(row!.status).toBe('declined');
    // The link no longer opens anything, and the sender heard about it.
    expect((await p.request('/session', json({ token }))).status).toBe(404);
    expect(mail.transport!.sent.some((m) => to(m) === 'gert@example.com')).toBe(true);
    const links = await master.select().from(masterSchema.signLinkRegistry).where(eq(masterSchema.signLinkRegistry.envelopeId, envelope.id));
    expect(links.every((l) => l.revokedAt)).toBe(true);
  });

  it('reports an expired request as closed', async () => {
    const { envelope } = await draftWithTwoSigners({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const token = linksByRecipient().get('ann@example.com')!;
    await db.update(schema.signEnvelopes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.signEnvelopes.id, envelope.id));
    await master.update(masterSchema.signLinkRegistry).set({ expiresAt: null }).where(eq(masterSchema.signLinkRegistry.envelopeId, envelope.id));
    const res = await data<{ state: string; reason: string }>(await portal().request('/session', json({ token })));
    expect(res).toEqual({ state: 'closed', reason: 'expired' });
  });

  it('refuses to send a draft that is not complete', async () => {
    const app = member();
    const draft = await data<SignEnvelopeDetail>(await app.request(BASE, json({ title: 'Empty' })));
    const [row] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, draft.id));
    await expect(
      sendEnvelope({ env: env(), db, master, clerkOrgId: ORG, workspaceId: WS }, row!, { userId: 'u', name: null, email: null }),
    ).rejects.toThrow('Add at least one document');
  });
});
