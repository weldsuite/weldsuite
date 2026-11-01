/**
 * /api/commerce-portal (staff): portal settings, the access list, invites,
 * revokes and resends, against a real tenant and master database (pglite).
 *
 * The master database resolves the workspace slug (the portal URL and the
 * link in the sign-in mail): `getMasterDb` is mocked to hand out the test's
 * master pglite through `conformanceMasterDb`. Invites and resends store a
 * sign-in challenge in `WORKSPACE_CACHE` (an in-memory KV stub), count
 * against `PORTAL_RATE_LIMITER` (the in-memory namespace) and send the
 * magic-link mail through `SEND_EMAIL` (a `createSendEmailStub()`), so the
 * mail is actually built and sent, and the link and code in it are checked
 * against the stored challenge.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { otpKvKey, sha256Hex, type PortalChallenge } from '@weldsuite/commerce-domain/portal-tokens';
import { createMemoryRateLimitNamespace } from '../../testing/memory-rate-limiter';
import type { Env } from '../../types';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import { commercePortalStaffRoutes } from './index';

const WORKSPACE_ID = 'ws_test_default';
const WORKSPACE_SLUG = 'acme-portal';
/** `commercePortalOrigin` for ENVIRONMENT=test (the harness default). */
const PORTAL_ORIGIN = 'https://orders-test.weldsuite.org';
const STAFF_USER = 'user_portal_staff';
const ALL_KEYS = ['companies:read', 'companies:update'];

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

class MemoryKV {
  private readonly store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === 'json' ? (JSON.parse(raw) as unknown) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  json<T>(key: string): T | null {
    const raw = this.store.get(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  }
}

/** The bindings one test sends through; fresh per test. */
let kv: MemoryKV;
let mail: ReturnType<typeof createSendEmailStub>;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.delete(masterSchema.workspaces).where(eq(masterSchema.workspaces.id, WORKSPACE_ID));
  await master.insert(masterSchema.workspaces).values({
    id: WORKSPACE_ID,
    clerkOrgId: 'org_test_default',
    name: 'Acme',
    slug: WORKSPACE_SLUG,
  });
}, 180_000);

beforeEach(() => {
  kv = new MemoryKV();
  mail = createSendEmailStub();
});

interface StaffOptions {
  keys?: string[];
  workspaceId?: string;
  /** Bind the portal's rate-limit counters (default true). */
  limiter?: boolean;
}

function staff(opts: StaffOptions = {}) {
  const env: Partial<Env> = {
    WORKSPACE_CACHE: kv as unknown as KVNamespace,
    SEND_EMAIL: mail as unknown as Env['SEND_EMAIL'],
  };
  if (opts.limiter !== false) {
    env.PORTAL_RATE_LIMITER = createMemoryRateLimitNamespace() as unknown as Env['PORTAL_RATE_LIMITER'];
  }
  return createTestApp('/api/commerce-portal', commercePortalStaffRoutes, {
    context: {
      userId: STAFF_USER,
      workspaceId: opts.workspaceId ?? WORKSPACE_ID,
      tenantDb: db,
      masterDb: master,
      permissions: permissions(...(opts.keys ?? ALL_KEYS)),
    },
    env,
  });
}

function call(path: string, init: { method?: string; body?: unknown } = {}, opts: StaffOptions = {}) {
  return staff(opts).request(`/api/commerce-portal${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

// ── seeds ──────────────────────────────────────────────────────────────────

async function seedPortalSettings(values: Partial<typeof schema.commercePortalSettings.$inferInsert> = {}) {
  await db.delete(schema.commercePortalSettings);
  await db.insert(schema.commercePortalSettings).values({ id: 'cps_staff', isEnabled: 1, ...values });
}

async function seedPerson(id: string, email: string | null, deleted = false) {
  await db.insert(schema.people).values({
    id,
    displayName: `Person ${id}`,
    email,
    ...(deleted ? { deletedAt: new Date('2030-01-01T00:00:00.000Z') } : {}),
  });
}

async function seedCompany(id: string, opts: { party?: boolean; deleted?: boolean } = {}) {
  await db.insert(schema.companies).values({
    id,
    name: `Company ${id}`,
    displayName: `Company ${id}`,
    ...(opts.deleted ? { deletedAt: new Date('2030-01-01T00:00:00.000Z') } : {}),
  });
  if (opts.party !== false) {
    await db.insert(schema.parties).values({
      id: `pty_${id}`,
      kind: 'company',
      companyId: id,
      displayName: `Company ${id}`,
      currency: 'EUR',
    });
  }
}

let linkSeq = 0;

async function linkPerson(personId: string, companyId: string, endedAt?: Date) {
  linkSeq += 1;
  await db.insert(schema.personCompanies).values({
    id: `pc_staff_${linkSeq}`,
    personId,
    companyId,
    startedAt: new Date('2029-01-01T00:00:00.000Z'),
    ...(endedAt ? { endedAt } : {}),
  });
}

/** A person with an email, linked to a company that has a commercial party. */
async function seedContact(key: string, email: string) {
  const personId = `pe_${key}`;
  const companyId = `co_${key}`;
  await seedPerson(personId, email);
  await seedCompany(companyId);
  await linkPerson(personId, companyId);
  return { personId, companyId };
}

async function seedAccess(
  id: string,
  values: { personId: string; companyId: string; email: string; status?: string; updatedAt?: Date },
) {
  await db.insert(schema.commercePortalAccess).values({
    id,
    personId: values.personId,
    companyId: values.companyId,
    email: values.email,
    status: values.status ?? 'invited',
    invitedBy: 'user_someone_else',
    invitedAt: new Date('2030-01-01T00:00:00.000Z'),
    ...(values.updatedAt ? { createdAt: values.updatedAt, updatedAt: values.updatedAt } : {}),
  });
}

async function accessRow(id: string) {
  const [row] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, id));
  return row;
}

// ── the sign-in mail, as a mail client reads it ─────────────────────────────

/** RFC 2047 encoded words (`=?utf-8?B?…?=`), as mimetext and lettre write them. */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_m, kind: string, text: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : decodeQuotedPrintable(text.replace(/_/g, ' ')),
    );
}

function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i]!, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerMap(head: string): Map<string, string> {
  const map = new Map<string, string>();
  let last: string | null = null;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && last) {
      map.set(last, `${map.get(last)} ${line.trim()}`);
      continue;
    }
    const at = line.indexOf(':');
    if (at > 0) {
      last = line.slice(0, at).trim().toLowerCase();
      map.set(last, line.slice(at + 1).trim());
    }
  }
  return map;
}

function splitHead(raw: string): { head: string; body: string } {
  const at = raw.indexOf('\n\n');
  return at < 0 ? { head: raw, body: '' } : { head: raw.slice(0, at), body: raw.slice(at + 2) };
}

/** The decoded text/plain part of a (possibly nested multipart) message. */
function plainText(head: string, body: string): string | null {
  const headers = headerMap(head);
  const contentType = headers.get('content-type') ?? 'text/plain';
  if (contentType.toLowerCase().startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (!boundary) return null;
    for (const section of body.split(`--${boundary}`).slice(1)) {
      if (section.startsWith('--')) break;
      const inner = splitHead(section.replace(/^\n/, ''));
      const text = plainText(inner.head, inner.body);
      if (text !== null) return text;
    }
    return null;
  }
  if (!contentType.toLowerCase().startsWith('text/plain')) return null;
  const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

interface SignInMail {
  to: string;
  subject: string;
  text: string;
  /** The magic-link token and the six-digit code in the text. */
  token: string | null;
  otp: string | null;
}

function sentMails(): SignInMail[] {
  return mail.sent.map((envelope) => {
    const { head, body } = splitHead(envelope.raw.replace(/\r\n/g, '\n'));
    const text = plainText(head, body) ?? '';
    return {
      to: envelope.to,
      subject: decodeWords(headerMap(head).get('subject') ?? ''),
      text,
      token: /\/auth\/callback\?token=([0-9a-f]{64})/.exec(text)?.[1] ?? null,
      otp: /\b(\d{6})\b/.exec(text)?.[1] ?? null,
    };
  });
}

/** The stored challenge for `email`, checked against the one mail sent to it. */
async function expectChallengeMailed(workspaceId: string, email: string, accessId: string) {
  const challenge = kv.json<PortalChallenge>(otpKvKey(workspaceId, email));
  expect(challenge).toMatchObject({ email, workspaceId, accessIds: [accessId], attempts: 0 });
  expect(kv.has(`cportal:tok:${challenge!.tokenHash}`)).toBe(true);

  const mails = sentMails();
  expect(mails).toHaveLength(1);
  const [sent] = mails;
  expect(sent!.to).toBe(email);
  expect(sent!.text).toContain(`${PORTAL_ORIGIN}/${WORKSPACE_SLUG}/auth/callback?token=`);
  // The link and the code are the challenge's: a buyer can redeem either.
  expect(await sha256Hex(sent!.token!)).toBe(challenge!.tokenHash);
  expect(await sha256Hex(sent!.otp!)).toBe(challenge!.otpHash);
  return sent!;
}

// ── settings ───────────────────────────────────────────────────────────────

const EMPTY_SETTINGS = {
  id: null,
  isEnabled: false,
  displayName: null,
  logo: null,
  primaryColor: null,
  accentColor: null,
};

describe('GET /api/commerce-portal/settings', () => {
  it('answers the defaults when the workspace has no settings row', async () => {
    await db.delete(schema.commercePortalSettings);
    const res = await call('/settings');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      ...EMPTY_SETTINGS,
      portalUrl: `${PORTAL_ORIGIN}/${WORKSPACE_SLUG}`,
      workspaceSlug: WORKSPACE_SLUG,
    });
  });

  it('answers no portal URL when the workspace has no master row (no slug)', async () => {
    await db.delete(schema.commercePortalSettings);
    const res = await call('/settings', {}, { workspaceId: 'ws_portal_unknown' });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ ...EMPTY_SETTINGS, portalUrl: null, workspaceSlug: null });
  });

  it('answers the stored row with the portal URL from the workspace slug', async () => {
    await seedPortalSettings({
      isEnabled: 1,
      displayName: 'Acme Orders',
      logo: 'https://cdn.example.com/acme.png',
      primaryColor: '#112233',
      accentColor: '#445566',
    });
    const res = await call('/settings');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      id: 'cps_staff',
      isEnabled: true,
      displayName: 'Acme Orders',
      logo: 'https://cdn.example.com/acme.png',
      primaryColor: '#112233',
      accentColor: '#445566',
      portalUrl: `${PORTAL_ORIGIN}/${WORKSPACE_SLUG}`,
      workspaceSlug: WORKSPACE_SLUG,
    });
  });

  it('reports a disabled row as isEnabled false', async () => {
    await seedPortalSettings({ isEnabled: 0, displayName: 'Closed' });
    const res = await call('/settings');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'cps_staff', isEnabled: false, displayName: 'Closed' });
  });

  it('refuses a caller without companies:read (403)', async () => {
    const res = await call('/settings', {}, { keys: ['companies:update'] });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/commerce-portal/settings', () => {
  it('creates the row on the first save, then patches only the fields sent', async () => {
    await db.delete(schema.commercePortalSettings);

    const created = await call('/settings', {
      method: 'PATCH',
      body: { isEnabled: true, displayName: 'Acme Orders', primaryColor: '#112233' },
    });
    expect(created.status).toBe(200);
    const first = await data<{ id: string }>(created);
    expect(first).toEqual({
      id: expect.stringMatching(/^cps_/),
      isEnabled: true,
      displayName: 'Acme Orders',
      logo: null,
      primaryColor: '#112233',
      accentColor: null,
      portalUrl: `${PORTAL_ORIGIN}/${WORKSPACE_SLUG}`,
      workspaceSlug: WORKSPACE_SLUG,
    });
    expect(await db.select().from(schema.commercePortalSettings)).toHaveLength(1);

    const patched = await call('/settings', {
      method: 'PATCH',
      body: { displayName: null, accentColor: '#445566', logo: 'https://cdn.example.com/logo.svg' },
    });
    expect(patched.status).toBe(200);
    expect(await data(patched)).toEqual({
      id: first.id,
      isEnabled: true,
      displayName: null,
      logo: 'https://cdn.example.com/logo.svg',
      primaryColor: '#112233',
      accentColor: '#445566',
      portalUrl: `${PORTAL_ORIGIN}/${WORKSPACE_SLUG}`,
      workspaceSlug: WORKSPACE_SLUG,
    });

    const disabled = await call('/settings', { method: 'PATCH', body: { isEnabled: false } });
    expect(disabled.status).toBe(200);
    expect(await data(disabled)).toMatchObject({ id: first.id, isEnabled: false, primaryColor: '#112233' });
    expect(await db.select().from(schema.commercePortalSettings)).toHaveLength(1);
  });

  it('creates a disabled row when the first save leaves isEnabled out', async () => {
    await db.delete(schema.commercePortalSettings);
    const res = await call('/settings', { method: 'PATCH', body: { displayName: 'Draft portal' } });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ isEnabled: false, displayName: 'Draft portal', logo: null });
  });

  it('answers no portal URL for a workspace without a slug', async () => {
    await seedPortalSettings({ isEnabled: 0 });
    const res = await call('/settings', { method: 'PATCH', body: { isEnabled: true } }, { workspaceId: 'ws_portal_unknown' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'cps_staff', isEnabled: true, portalUrl: null, workspaceSlug: null });
  });

  it('refuses a body that does not validate (400)', async () => {
    await seedPortalSettings({ isEnabled: 0 });
    expect((await call('/settings', { method: 'PATCH', body: { isEnabled: 'yes' } })).status).toBe(400);
    expect((await call('/settings', { method: 'PATCH', body: { displayName: 'x'.repeat(256) } })).status).toBe(400);
    expect((await call('/settings', { method: 'PATCH', body: { primaryColor: 42 } })).status).toBe(400);
    const [row] = await db.select().from(schema.commercePortalSettings);
    expect(row?.isEnabled).toBe(0);
  });

  it('refuses a caller without companies:update (403)', async () => {
    const res = await call('/settings', { method: 'PATCH', body: { isEnabled: true } }, { keys: ['companies:read'] });
    expect(res.status).toBe(403);
  });
});

// ── access list ────────────────────────────────────────────────────────────

describe('GET /api/commerce-portal/access', () => {
  it('needs a companyId (400)', async () => {
    const res = await call('/access');
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'companyId is required' });
  });

  it("lists one company's access rows, most recently updated first", async () => {
    const a = await seedContact('list_a', 'list.a@example.com');
    await seedPerson('pe_list_b', 'list.b@example.com');
    await linkPerson('pe_list_b', a.companyId);
    const other = await seedContact('list_other', 'list.other@example.com');
    await seedAccess('cpa_list_old', {
      ...a,
      email: 'list.a@example.com',
      status: 'active',
      updatedAt: new Date('2030-02-01T00:00:00.000Z'),
    });
    await seedAccess('cpa_list_new', {
      personId: 'pe_list_b',
      companyId: a.companyId,
      email: 'list.b@example.com',
      status: 'revoked',
      updatedAt: new Date('2030-03-01T00:00:00.000Z'),
    });
    await seedAccess('cpa_list_other', { ...other, email: 'list.other@example.com' });

    const res = await call(`/access?companyId=${a.companyId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string; email: string }>;
      pagination: unknown;
    };
    expect(body.data.map((row) => [row.id, row.status, row.email])).toEqual([
      ['cpa_list_new', 'revoked', 'list.b@example.com'],
      ['cpa_list_old', 'active', 'list.a@example.com'],
    ]);
    expect(body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
  });

  it('answers an empty list for a company without access rows', async () => {
    const res = await call('/access?companyId=co_nobody');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it('refuses a caller without companies:read (403)', async () => {
    const res = await call('/access?companyId=co_list_a', {}, { keys: [] });
    expect(res.status).toBe(403);
  });
});

// ── invite ─────────────────────────────────────────────────────────────────

function invite(body: unknown, opts: StaffOptions = {}) {
  return call('/access/invite', { method: 'POST', body }, opts);
}

describe('POST /api/commerce-portal/access/invite', () => {
  it('invites a contact (201), stores the challenge and mails the link and code', async () => {
    await seedPortalSettings({ isEnabled: 1, displayName: 'Acme Orders', accentColor: '#445566' });
    const { personId, companyId } = await seedContact('inv_new', '  Buyer.New@Example.COM ');

    const res = await invite({ personId, companyId });
    expect(res.status).toBe(201);
    const row = await data<Record<string, unknown> & { id: string }>(res);
    expect(row).toMatchObject({
      id: expect.stringMatching(/^cpa_/),
      personId,
      companyId,
      email: 'buyer.new@example.com',
      status: 'invited',
      invitedBy: STAFF_USER,
      invitedAt: expect.any(String),
      lastLoginAt: null,
    });
    expect(await accessRow(row.id)).toMatchObject({ email: 'buyer.new@example.com', status: 'invited' });

    const sent = await expectChallengeMailed(WORKSPACE_ID, 'buyer.new@example.com', row.id);
    // Branded with the portal's display name.
    expect(sent.subject).toContain('Acme Orders');
  });

  it('re-invites an existing active access (200) and keeps it active', async () => {
    await seedPortalSettings({ isEnabled: 1 });
    const { personId, companyId } = await seedContact('inv_active', 'Active.Buyer@example.com');
    await seedAccess('cpa_inv_active', { personId, companyId, email: 'old.address@example.com', status: 'active' });

    const res = await invite({ personId, companyId });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'cpa_inv_active',
      email: 'active.buyer@example.com',
      status: 'active',
      invitedBy: STAFF_USER,
    });
    expect(await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.personId, personId))).toHaveLength(1);
    const sent = await expectChallengeMailed(WORKSPACE_ID, 'active.buyer@example.com', 'cpa_inv_active');
    // No display name: the company's name.
    expect(sent.subject).toContain('Company co_inv_active');
  });

  it('re-invites a revoked access as invited again (200)', async () => {
    await seedPortalSettings({ isEnabled: 1 });
    const { personId, companyId } = await seedContact('inv_revoked', 'revoked.buyer@example.com');
    await seedAccess('cpa_inv_revoked', { personId, companyId, email: 'revoked.buyer@example.com', status: 'revoked' });

    const res = await invite({ personId, companyId });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'cpa_inv_revoked', status: 'invited' });
    expect((await accessRow('cpa_inv_revoked'))?.status).toBe('invited');
  });

  it('stores the challenge but sends no mail when the workspace has no slug', async () => {
    const { personId, companyId } = await seedContact('inv_noslug', 'noslug.buyer@example.com');
    const res = await invite({ personId, companyId }, { workspaceId: 'ws_portal_unknown' });
    expect(res.status).toBe(201);
    const row = await data<{ id: string }>(res);
    expect(kv.json<PortalChallenge>(otpKvKey('ws_portal_unknown', 'noslug.buyer@example.com'))).toMatchObject({
      workspaceId: 'ws_portal_unknown',
      accessIds: [row.id],
    });
    expect(mail.sent).toHaveLength(0);
  });

  it('saves the invite but issues no challenge without the rate-limit counters', async () => {
    const { personId, companyId } = await seedContact('inv_nolimit', 'nolimit.buyer@example.com');
    const res = await invite({ personId, companyId }, { limiter: false });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ email: 'nolimit.buyer@example.com', status: 'invited' });
    expect(kv.has(otpKvKey(WORKSPACE_ID, 'nolimit.buyer@example.com'))).toBe(false);
    expect(mail.sent).toHaveLength(0);
  });

  it('answers 404 for an unknown or deleted person', async () => {
    await seedCompany('co_inv_lone');
    const unknown = await invite({ personId: 'pe_inv_missing', companyId: 'co_inv_lone' });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'NOT_FOUND', message: "Person with ID 'pe_inv_missing' not found" });

    await seedPerson('pe_inv_deleted', 'deleted@example.com', true);
    expect((await invite({ personId: 'pe_inv_deleted', companyId: 'co_inv_lone' })).status).toBe(404);
  });

  it('answers 400 for a person without an email address', async () => {
    await seedCompany('co_inv_noemail');
    await seedPerson('pe_inv_noemail', null);
    await seedPerson('pe_inv_blank', '   ');
    for (const personId of ['pe_inv_noemail', 'pe_inv_blank']) {
      await linkPerson(personId, 'co_inv_noemail');
      const res = await invite({ personId, companyId: 'co_inv_noemail' });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Person must have an email address' });
    }
  });

  it('answers 404 for an unknown or deleted company', async () => {
    await seedPerson('pe_inv_nocompany', 'nocompany@example.com');
    const unknown = await invite({ personId: 'pe_inv_nocompany', companyId: 'co_inv_missing' });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'NOT_FOUND', message: "Company with ID 'co_inv_missing' not found" });

    await seedCompany('co_inv_deleted', { deleted: true });
    await linkPerson('pe_inv_nocompany', 'co_inv_deleted');
    expect((await invite({ personId: 'pe_inv_nocompany', companyId: 'co_inv_deleted' })).status).toBe(404);
  });

  it('answers 400 when the person is not an active contact at the company', async () => {
    await seedPerson('pe_inv_stranger', 'stranger@example.com');
    await seedCompany('co_inv_stranger');
    const unlinked = await invite({ personId: 'pe_inv_stranger', companyId: 'co_inv_stranger' });
    expect(unlinked.status).toBe(400);
    expect(await errorOf(unlinked)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Person is not an active contact at this company',
    });

    await seedPerson('pe_inv_former', 'former@example.com');
    await linkPerson('pe_inv_former', 'co_inv_stranger', new Date('2030-01-01T00:00:00.000Z'));
    expect((await invite({ personId: 'pe_inv_former', companyId: 'co_inv_stranger' })).status).toBe(400);
    expect(
      await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.companyId, 'co_inv_stranger')),
    ).toHaveLength(0);
  });

  it('answers 400 when the company has no commercial party record', async () => {
    await seedPerson('pe_inv_noparty', 'noparty@example.com');
    await seedCompany('co_inv_noparty', { party: false });
    await linkPerson('pe_inv_noparty', 'co_inv_noparty');
    const res = await invite({ personId: 'pe_inv_noparty', companyId: 'co_inv_noparty' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Company has no commercial party record' });
  });

  it('refuses a body that does not validate (400)', async () => {
    expect((await invite({})).status).toBe(400);
    expect((await invite({ personId: '', companyId: 'co_x' })).status).toBe(400);
    expect((await invite({ personId: 'pe_x', companyId: 7 })).status).toBe(400);
  });

  it('refuses a caller without companies:update (403)', async () => {
    const res = await invite({ personId: 'pe_inv_new', companyId: 'co_inv_new' }, { keys: ['companies:read'] });
    expect(res.status).toBe(403);
    expect(mail.sent).toHaveLength(0);
  });
});

// ── revoke ─────────────────────────────────────────────────────────────────

describe('POST /api/commerce-portal/access/:id/revoke', () => {
  it('revokes an access row', async () => {
    const { personId, companyId } = await seedContact('rev', 'revoke.me@example.com');
    await seedAccess('cpa_rev', { personId, companyId, email: 'revoke.me@example.com', status: 'active' });
    const res = await call('/access/cpa_rev/revoke', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'cpa_rev', status: 'revoked', email: 'revoke.me@example.com' });
    expect((await accessRow('cpa_rev'))?.status).toBe('revoked');
  });

  it('answers 404 for an unknown access row', async () => {
    const res = await call('/access/cpa_missing/revoke', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Portal access with ID 'cpa_missing' not found" });
  });

  it('refuses a caller without companies:update (403)', async () => {
    const res = await call('/access/cpa_rev/revoke', { method: 'POST' }, { keys: ['companies:read'] });
    expect(res.status).toBe(403);
  });
});

// ── resend ─────────────────────────────────────────────────────────────────

describe('POST /api/commerce-portal/access/:id/resend', () => {
  it('issues a fresh challenge and mails it', async () => {
    await seedPortalSettings({ isEnabled: 1, displayName: 'Acme Orders' });
    const { personId, companyId } = await seedContact('resend', 'resend.me@example.com');
    await seedAccess('cpa_resend', { personId, companyId, email: 'resend.me@example.com', status: 'active' });

    const res = await call('/access/cpa_resend/resend', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const sent = await expectChallengeMailed(WORKSPACE_ID, 'resend.me@example.com', 'cpa_resend');
    // Unlike an invite, a resend does not pass the portal's branding: the
    // mail names the company's order portal, not the display name.
    expect(sent.subject).toContain('Company co_resend order portal');
    expect(sent.subject).not.toContain('Acme Orders');
    // The access row itself is untouched.
    expect(await accessRow('cpa_resend')).toMatchObject({ status: 'active', invitedBy: 'user_someone_else' });
  });

  it('answers 404 for an unknown access row', async () => {
    const res = await call('/access/cpa_missing/resend', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Portal access with ID 'cpa_missing' not found" });
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses to resend to a revoked access (400)', async () => {
    const { personId, companyId } = await seedContact('resend_rev', 'resend.revoked@example.com');
    await seedAccess('cpa_resend_rev', { personId, companyId, email: 'resend.revoked@example.com', status: 'revoked' });
    const res = await call('/access/cpa_resend_rev/resend', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Access is revoked' });
    expect(kv.has(otpKvKey(WORKSPACE_ID, 'resend.revoked@example.com'))).toBe(false);
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses a caller without companies:update (403)', async () => {
    const res = await call('/access/cpa_resend/resend', { method: 'POST' }, { keys: ['companies:read'] });
    expect(res.status).toBe(403);
  });
});
