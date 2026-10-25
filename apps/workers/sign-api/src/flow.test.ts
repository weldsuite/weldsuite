/**
 * The whole signing flow against pglite (tenant + master), an in-memory
 * bucket, KV and mail transport: a draft with two signers in order and a copy
 * recipient is sent, both sign through the portal routes, and the request is
 * finalized into one PDF with a certificate whose hash is recorded.
 *
 * The portal half runs @weldsuite/sign-domain/portal directly, as
 * apps/web/sign-portal does. Also: codes, consent, required fields, decline,
 * expiry, the signer's IP and browser on the evidence trail, and finishing
 * again when finalizing could not start.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { memoryCodeAttempts } from '@weldsuite/sign-domain/code-attempts.memory';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  SignDocumentDto,
  SignEnvelopeDetail,
  SignEnvelopeSummary,
  SignEventDto,
  SignPortalEnvelope,
  SignRecipientDto,
} from '@weldsuite/app-api-client/schemas/weldsign';
import envelopesRoutes from './routes/envelopes';
import { createSignPortal, type PortalContext, type SignerMeta } from '@weldsuite/sign-domain/portal';
import { advanceAfterSigning, sendEnvelope } from '@weldsuite/sign-domain/sending';
import { buildFinalPdf, notifyCompleted } from '@weldsuite/sign-domain/finalize';
import { sha256Hex } from '@weldsuite/sign-domain/hash';
import { completeSigning, loadSigner } from '@weldsuite/sign-domain/signing';
import type { Env } from './types';

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
// The lifecycle routes resolve the master DB and the workspace's master id themselves.
const dbs = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => dbs.master, getWorkspaceForOrg: async () => ({ id: 'ws_flow' }) };
});

const ORG = 'org_flow';
const WS = 'ws_flow';
const SECRET = 'flow-test-secret';
const BASE = '/api/sign/envelopes';

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
const codeAttempts = memoryCodeAttempts();
const finalizeCalls: unknown[] = [];

function env(): Env {
  return {
    PRIVATE_STORAGE: storage.bucket,
    WORKSPACE_CACHE: kv,
    SIGN_CODE_ATTEMPTS: codeAttempts,
    SIGN_SESSION_SECRET: SECRET,
    SIGN_PORTAL_URL: 'https://sign.test',
    ENVIRONMENT: 'test',
  } as unknown as Env;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.master = master;
}, 120_000);

beforeEach(() => {
  mail.transport = memoryTransport();
  finalizeCalls.length = 0;
});

function member(grants: string[] = ['*'], userId = 'user_sender') {
  return createTestApp(BASE, envelopesRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, workspaceId: ORG, orgId: ORG },
    env: env() as Partial<Env>,
  });
}

/** A stand-in for the FINALIZE_ENVELOPE Workflow binding whose first `create` fails, like a Workflows API outage. */
function flakyWorkflow() {
  const calls: string[] = [];
  const instances = new Map<string, { status: string; restarted: number }>();
  let failNext = true;
  const binding = {
    async create({ id }: { id: string }) {
      calls.push(id);
      if (failNext) {
        failNext = false;
        throw new Error('Workflows API unavailable');
      }
      if (instances.has(id)) throw new Error('instance.already_exists');
      instances.set(id, { status: 'running', restarted: 0 });
      return { id };
    },
    async get(id: string) {
      const instance = instances.get(id);
      if (!instance) throw new Error('instance.not_found');
      return {
        id,
        status: async () => ({ status: instance.status }),
        restart: async () => {
          instance.restarted++;
          instance.status = 'running';
        },
      };
    },
  };
  return { calls, instances, binding };
}

/**
 * The signer portal as apps/web/sign-portal runs it: each path of its
 * `/api/*` routes maps to one operation of the domain portal, with the
 * signer's IP and browser it reads from the request.
 */
function portal(extraEnv: Partial<Env> = {}, meta: SignerMeta = { ip: '203.0.113.9', userAgent: 'FlowTest/1.0' }) {
  const ops = createSignPortal({
    master: () => master,
    workspace: async () => ({ id: WS, db, suspended: false }),
    finalize: async (_env, params) => {
      finalizeCalls.push(params);
    },
  });
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    request: async (path: string, init: RequestInit = {}, session?: string): Promise<Response> => {
      const ctx: PortalContext = { env: { ...env(), ...extraEnv }, meta, waitUntil: (p) => pending.push(p.catch(() => undefined)) };
      const input: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const document = /^\/documents\/(.+)$/.exec(path);
      if (document) return ops.document(ctx, session, document[1]!);
      switch (path) {
        case '/session': return ops.openSession(ctx, input);
        case '/verify': return ops.verify(ctx, input);
        case '/resend-code': return ops.resendCode(ctx, input);
        case '/envelope': return ops.envelope(ctx, session);
        case '/consent': return ops.consent(ctx, session, input);
        case '/complete': return ops.complete(ctx, session, input);
        case '/decline': return ops.decline(ctx, session, input);
        case '/download': return ops.download(ctx, session);
        default: throw new Error(`no portal operation for ${path}`);
      }
    },
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

  it('records the signer IP and browser the portal reads from the request', async () => {
    const { ann } = await draftWithTwoSigners();
    const token = linksByRecipient().get('ann@example.com')!;
    await portal({}, { ip: '198.51.100.7', userAgent: 'Other/2.0' }).request('/session', json({ token }));
    const [opened] = await db
      .select()
      .from(schema.signEvents)
      .where(and(eq(schema.signEvents.recipientId, ann.id), eq(schema.signEvents.type, 'opened')));
    expect(opened).toMatchObject({ ip: '198.51.100.7', userAgent: 'Other/2.0' });
  });

  it('lets the last signer finish again when finalizing could not start', async () => {
    const { envelope, bob } = await draftWithTwoSigners();
    await db.update(schema.signRecipients).set({ authMode: 'link' }).where(eq(schema.signRecipients.id, bob.id));
    const workflow = flakyWorkflow();
    const p = portal({ FINALIZE_ENVELOPE: workflow.binding as never });

    const annSession = await openAndConsent(p, linksByRecipient().get('ann@example.com')!);
    const jobTitle = (await data<SignPortalEnvelope>(await p.request('/envelope', {}, annSession))).fields.find((f) => f.type === 'text')!;
    expect((await p.request('/complete', json({ values: [{ fieldId: jobTitle.id, value: 'Director' }], signature }), annSession)).status).toBe(200);

    const bobSession = await openAndConsent(p, linksByRecipient().get('bob@example.com')!);
    const box = (await data<SignPortalEnvelope>(await p.request('/envelope', {}, bobSession))).fields.find((f) => f.type === 'checkbox')!;
    const finishBob = () => p.request('/complete', json({ values: [{ fieldId: box.id, value: 'true' }], signature }), bobSession);

    // The Workflows API fails once: Bob hears so, and his signature is kept.
    expect((await finishBob()).status).toBe(503);
    const [bobRow] = await db.select().from(schema.signRecipients).where(eq(schema.signRecipients.id, bob.id));
    expect(bobRow!.status).toBe('signed');

    // Finishing again starts it; another try finds it running and leaves it alone.
    expect((await finishBob()).status).toBe(200);
    expect((await finishBob()).status).toBe(200);
    const id = `finalize-${envelope.id}`;
    expect(workflow.calls).toEqual([id, id, id]);
    expect(workflow.instances.get(id)).toEqual({ status: 'running', restarted: 0 });

    // A run that failed is restarted by the next start, here from reopening a link.
    workflow.instances.get(id)!.status = 'errored';
    await p.request('/session', json({ token: linksByRecipient().get('ann@example.com') }));
    await Promise.all(p.pending);
    expect(workflow.instances.get(id)).toEqual({ status: 'running', restarted: 1 });
  });

  it('lets only one of two simultaneous submissions sign', async () => {
    const { envelope, ann } = await draftWithTwoSigners();
    const p = portal();
    const session = await openAndConsent(p, linksByRecipient().get('ann@example.com')!);
    const view = await data<SignPortalEnvelope>(await p.request('/envelope', {}, session));
    const jobTitle = view.fields.find((f) => f.type === 'text')!;
    const input = { values: [{ fieldId: jobTitle.id, value: 'Director' }], signature, initials: null, timeZone: 'UTC' };

    // Both submissions loaded the recipient before either wrote: only one may flip it to signed.
    const ref = await loadSigner(db, envelope.id, ann.id);
    const ctx = { db, bucket: storage.bucket, workspaceId: ORG, meta: { ip: null, userAgent: null } };
    const results = await Promise.allSettled([completeSigning(ctx, ref, input), completeSigning(ctx, ref, input)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ kind: 'conflict' });
    const events = await db.select().from(schema.signEvents).where(and(eq(schema.signEvents.envelopeId, envelope.id), eq(schema.signEvents.type, 'signed')));
    expect(events.filter((e) => e.recipientId === ann.id)).toHaveLength(1);
  });

  it('mails the next signing group once when the last signers of a group finish together', async () => {
    const { envelope, ann, bob } = await draftWithTwoSigners();
    await db.update(schema.signRecipients).set({ status: 'signed', signedAt: new Date() }).where(eq(schema.signRecipients.id, ann.id));
    const [row] = await db.select().from(schema.signEnvelopes).where(eq(schema.signEnvelopes.id, envelope.id));
    const ctx = { env: env(), db, master, clerkOrgId: ORG, workspaceId: WS };
    mail.transport = memoryTransport();

    const results = await Promise.all([advanceAfterSigning(ctx, row!), advanceAfterSigning(ctx, row!)]);
    expect([...results].sort()).toEqual(['next_group', 'waiting']);
    expect(mail.transport.sent.map(to)).toEqual(['bob@example.com']);
    const links = await master.select().from(masterSchema.signLinkRegistry).where(eq(masterSchema.signLinkRegistry.recipientId, bob.id));
    expect(links).toHaveLength(1);
    const sentEvents = await db.select().from(schema.signEvents).where(and(eq(schema.signEvents.recipientId, bob.id), eq(schema.signEvents.type, 'sent')));
    expect(sentEvents).toHaveLength(1);
  });

  it('gives a copy recipient the link auth mode and no code', async () => {
    const app = member();
    const draft = await data<SignEnvelopeDetail>(await app.request(BASE, json({ title: 'Copies' })));
    const add = (body: Record<string, unknown>) => app.request(`${BASE}/${draft.id}/recipients`, json(body));
    const cc = await data<SignRecipientDto>(await add({ name: 'Cc', email: 'cc@example.com', role: 'cc', authMode: 'access_code', accessCode: '1234' }));
    expect(cc).toMatchObject({ role: 'cc', authMode: 'link', hasAccessCode: false });

    // A signer with a code who becomes a copy recipient loses both.
    const signerWithCode = await data<SignRecipientDto>(await add({ name: 'S', email: 's@example.com', authMode: 'access_code', accessCode: '1234' }));
    expect(signerWithCode).toMatchObject({ authMode: 'access_code', hasAccessCode: true });
    const patched = await app.request(`${BASE}/${draft.id}/recipients/${signerWithCode.id}`, json({ role: 'cc' }, 'PATCH'));
    expect(await data<SignRecipientDto>(patched)).toMatchObject({ role: 'cc', authMode: 'link', hasAccessCode: false });
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

const POST = { method: 'POST' } satisfies RequestInit;

/** The signing link in the last mail sent to `email`. */
function lastLinkFor(email: string): string {
  const mailToThem = mail.transport!.sent.filter((m) => to(m) === email).at(-1);
  return /https:\/\/sign\.test\/r\/([A-Za-z0-9_-]+)/.exec(mailToThem?.text ?? '')![1]!;
}

describe('a sent request', () => {
  it('voids: the links stop, signers who got it hear why, nothing more can be done', async () => {
    const { envelope } = await draftWithTwoSigners();
    const annToken = linksByRecipient().get('ann@example.com')!;
    mail.transport = memoryTransport();
    const app = member();

    const res = await app.request(`${BASE}/${envelope.id}/void`, json({ reason: 'Wrong version attached.' }));
    expect(res.status).toBe(200);
    expect(await data<SignEnvelopeDetail>(res)).toMatchObject({ status: 'voided', voidedReason: 'Wrong version attached.', canVoid: false, canRemind: false });
    // Ann had the request and is told; Bob's turn never came, so he never heard of it.
    expect(mail.transport.sent.map(to)).toEqual(['ann@example.com']);
    expect(mail.transport.sent[0]!.text).toContain('Wrong version attached.');
    expect((await portal().request('/session', json({ token: annToken }))).status).toBe(404);

    expect((await app.request(`${BASE}/${envelope.id}/void`, json({ reason: 'Again' }))).status).toBe(409);
    expect((await app.request(`${BASE}/${envelope.id}/remind`, POST)).status).toBe(409);
    const events = await data<SignEventDto[]>(await app.request(`${BASE}/${envelope.id}/events`));
    expect(events.at(-1)).toMatchObject({ type: 'voided', details: { reason: 'Wrong version attached.' } });
  });

  it('reminds by hand at most once an hour, with a link that opens the request', async () => {
    const { envelope, ann } = await draftWithTwoSigners();
    const app = member();
    // Ann was emailed a moment ago.
    expect((await app.request(`${BASE}/${envelope.id}/remind`, POST)).status).toBe(409);

    await db.update(schema.signRecipients).set({ sentAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(schema.signRecipients.id, ann.id));
    mail.transport = memoryTransport();
    expect(await data<{ reminded: number }>(await app.request(`${BASE}/${envelope.id}/remind`, POST))).toEqual({ reminded: 1 });
    expect(mail.transport.sent.map(to)).toEqual(['ann@example.com']);
    expect(mail.transport.sent[0]!.subject).toMatch(/^Reminder:/);
    expect(await data<{ state: string }>(await portal().request('/session', json({ token: lastLinkFor('ann@example.com') })))).toMatchObject({ state: 'ready' });

    const [row] = await db.select().from(schema.signRecipients).where(eq(schema.signRecipients.id, ann.id));
    expect(row!.lastRemindedAt).not.toBeNull();
    // By hand: it does not use up an automatic reminder.
    expect(row!.remindersSent).toBe(0);
    expect((await app.request(`${BASE}/${envelope.id}/remind`, POST)).status).toBe(409);
  });

  it('sends one signer a new link, only when it is their turn', async () => {
    const { envelope, ann, bob } = await draftWithTwoSigners();
    const app = member();
    mail.transport = memoryTransport();
    expect((await app.request(`${BASE}/${envelope.id}/recipients/${ann.id}/resend`, POST)).status).toBe(200);
    expect(mail.transport.sent.map(to)).toEqual(['ann@example.com']);
    expect(mail.transport.sent[0]!.subject).not.toMatch(/^Reminder:/);
    expect((await app.request(`${BASE}/${envelope.id}/recipients/${bob.id}/resend`, POST)).status).toBe(409);
    const events = await data<SignEventDto[]>(await app.request(`${BASE}/${envelope.id}/events`));
    expect(events.at(-1)).toMatchObject({ type: 'resent', recipientName: 'Ann' });
  });

  it('corrects an email: the old link stops, the new address gets one and agrees again', async () => {
    const { envelope, ann, bob } = await draftWithTwoSigners();
    const oldToken = linksByRecipient().get('ann@example.com')!;
    const p = portal();
    // Whoever holds the wrong address already agreed to sign electronically.
    const oldSession = await openAndConsent(p, oldToken);
    const app = member();
    mail.transport = memoryTransport();

    const res = await app.request(
      `${BASE}/${envelope.id}/recipients/${ann.id}/correct`,
      json({ name: 'Ann de Vries', email: 'Ann.deVries@example.com' }),
    );
    expect(res.status).toBe(200);
    expect(await data<SignRecipientDto>(res)).toMatchObject({ name: 'Ann de Vries', email: 'ann.devries@example.com', status: 'sent', openedAt: null });
    expect((await p.request('/session', json({ token: oldToken }))).status).toBe(404);
    // The session the wrong address already holds ends with its link: it reads nothing and signs nothing.
    expect((await p.request('/envelope', {}, oldSession)).status).toBe(401);
    expect((await p.request('/consent', json({ disclosureVersion: '2026-10-24' }), oldSession)).status).toBe(401);
    expect((await p.request('/complete', json({ values: [], signature }), oldSession)).status).toBe(401);
    const opened = await data<{ session: string }>(await p.request('/session', json({ token: lastLinkFor('ann.devries@example.com') })));
    const view = await data<SignPortalEnvelope>(await p.request('/envelope', {}, opened.session));
    expect(view.recipient.consented).toBe(false);

    // Taken by another recipient, or nothing changed: refused.
    expect((await app.request(`${BASE}/${envelope.id}/recipients/${ann.id}/correct`, json({ email: 'bob@example.com' }))).status).toBe(400);
    expect((await app.request(`${BASE}/${envelope.id}/recipients/${ann.id}/correct`, json({ email: 'ann.devries@example.com' }))).status).toBe(400);
    // Bob's turn has not come: his address changes and he is emailed nothing yet.
    mail.transport = memoryTransport();
    const bobRes = await app.request(`${BASE}/${envelope.id}/recipients/${bob.id}/correct`, json({ email: 'robert@example.com' }));
    expect(await data<SignRecipientDto>(bobRes)).toMatchObject({ email: 'robert@example.com', status: 'pending' });
    expect(mail.transport.sent).toHaveLength(0);

    const events = await data<SignEventDto[]>(await app.request(`${BASE}/${envelope.id}/events`));
    expect(events.find((e) => e.type === 'recipient_corrected')?.details).toMatchObject({ from: 'ann@example.com', to: 'ann.devries@example.com' });
  });

  it('keeps a signer’s consent when only their name is fixed', async () => {
    const { envelope, ann } = await draftWithTwoSigners();
    const p = portal();
    const session = await openAndConsent(p, linksByRecipient().get('ann@example.com')!);
    const res = await member().request(`${BASE}/${envelope.id}/recipients/${ann.id}/correct`, json({ name: 'Ann de Vries', email: 'ann@example.com' }));
    expect(await data<SignRecipientDto>(res)).toMatchObject({ name: 'Ann de Vries', email: 'ann@example.com', status: 'opened' });
    // Same person, same session: still agreed, and she can finish.
    expect((await data<SignPortalEnvelope>(await p.request('/envelope', {}, session))).recipient.consented).toBe(true);
    const view = await data<SignPortalEnvelope>(await p.request('/envelope', {}, session));
    const jobTitle = view.fields.find((f) => f.type === 'text')!;
    expect((await p.request('/complete', json({ values: [{ fieldId: jobTitle.id, value: 'Director' }], signature }), session)).status).toBe(200);
  });

  it('shows a member the requests waiting for their signature, and lets them sign now', async () => {
    const { envelope, ann } = await draftWithTwoSigners();
    await db.insert(schema.workspaceMembers).values({ id: generateId('wm'), userId: 'user_ann', email: 'Ann@Example.com', name: 'Ann' });
    const annApp = member(['sign_envelopes:read'], 'user_ann');

    const waiting = await annApp.request(`${BASE}?folder=action_required`);
    const rows = ((await waiting.json()) as { data: SignEnvelopeSummary[] }).data;
    expect(rows.map((r) => r.id)).toContain(envelope.id);
    expect(rows.every((r) => r.status === 'sent' || r.status === 'in_progress')).toBe(true);
    const detail = await data<SignEnvelopeDetail>(await annApp.request(`${BASE}/${envelope.id}`));
    expect(detail).toMatchObject({ isOwner: false, canEdit: false, canVoid: false, canRemind: false, mySignerId: ann.id });
    // Only the owner sees the activity.
    expect((await annApp.request(`${BASE}/${envelope.id}/events`)).status).toBe(404);

    const link = await data<{ url: string }>(await annApp.request(`${BASE}/${envelope.id}/signing-link`, POST));
    const token = /\/r\/([A-Za-z0-9_-]+)$/.exec(link.url)![1]!;
    expect(await data<{ state: string }>(await portal().request('/session', json({ token })))).toMatchObject({ state: 'ready' });

    // A draft that names her stays the sender's own; a member not on the request sees nothing.
    const draft = await data<SignEnvelopeDetail>(await member().request(BASE, json({ title: 'Still a draft' })));
    await member().request(`${BASE}/${draft.id}/recipients`, json({ name: 'Ann', email: 'ann@example.com' }));
    expect((await annApp.request(`${BASE}/${draft.id}`)).status).toBe(404);
    expect((await member(['sign_envelopes:read'], 'user_stranger').request(`${BASE}/${envelope.id}`)).status).toBe(404);
  });
});
