/**
 * The respondent side against pglite (tenant + master), in-memory KV, buckets,
 * counters and mail: the portal key, the cached public form and its states,
 * views, sessions (bot checks, invitations, verified email, resume, one per
 * respondent), codes and their lock, progress, uploads, submit (validation,
 * skipped answers, numbering, events without sensitive answers), the plan quota,
 * abuse reports and members-only filling.
 *
 * Every call goes through the kit's test harness (`createTestApp().request()`),
 * so these tests can be replayed against the Rust backend.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import type { FormDetail, PublicForm, StartSessionResult, SubmitSessionResult } from '@weldsuite/app-api-client/schemas/weldforms';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import { createAltchaChallenge } from './services/bot-check';
import { sha256Hex } from './lib/crypto';
import fillRoutes from './routes/fill';
import formsRoutes from './routes/forms';
import publicRoutes from './routes/public';
import { ORG, PORTAL_KEY, WS, eventNames, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, simpleDefinition, surveyDefinition, uploadDefinition, type World } from './test/support';

const mail = vi.hoisted(() => ({ transport: null as ReturnType<typeof memoryTransport> | null }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => mail.transport }));

// The conformance handles: in conformance mode the TypeScript run of a write
// gets the transaction it is rolled back in (the Rust run writes for real).
const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown, tenantOpened: 0 }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getWorkspaceContextForOrg: async () => {
      dbs.tenantOpened++;
      return { id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null };
    },
  };
});

let db: Database;
let master: MasterDatabase;
let world: World;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  shareMasterDb(master);
}, 120_000);

beforeEach(async () => {
  world = newWorld();
  mail.transport = memoryTransport();
  dbs.tenantOpened = 0;
  vi.unstubAllGlobals();
  await resetForms(db, master);
  await seedWorkspace(master);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Holds the clock at one instant for a burst of requests. The rate limits
 * count in fixed one-minute windows on the clock, so a burst that runs over a
 * minute's end starts counting again and never reaches its limit; conformance
 * sends every request to both backends, which makes that likely (main's CI
 * run 43382326767). Conformance passes the held clock to Rust too
 * (`CONFORMANCE_NOW`).
 */
function holdClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'));
}

const FORMS = '/api/forms/forms';
const PUBLIC = '/public/forms';
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

/** A published form with the given definition and settings; the link respondents use. */
async function publish(definition: FormDefinition, settings: Record<string, unknown> = {}, w: World = world): Promise<{ form: FormDetail; publicId: string }> {
  const members = memberApp(FORMS, formsRoutes, w, db);
  const created = await data<FormDetail>(await members.request(FORMS, json({ title: 'Survey' })));
  const saved = await data<FormDetail>(await members.request(`${FORMS}/${created.id}`, json({ revision: 1, definition, settings }, 'PATCH')));
  const { form } = await data<{ form: FormDetail }>(await members.request(`${FORMS}/${saved.id}/publish`, json({})));
  w.sent.length = 0;
  return { form, publicId: form.publicId! };
}

/**
 * The public routes as the portal calls them. The databases go in the
 * context only for conformance mode, which serves them to the Rust server
 * (the routes themselves open them through the mocks above).
 */
function portalApp(env: World['env']) {
  return createTestApp(PUBLIC, publicRoutes, {
    env,
    context: { tenantDb: db, masterDb: master as unknown as Database, workspaceId: WS, orgId: ORG, clerkOrgId: ORG },
  });
}

function portal(w: World = world) {
  const app = portalApp(w.env);
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    app.request(`${PUBLIC}${path}`, { ...init, headers: { 'X-Forms-Portal-Key': PORTAL_KEY, 'X-Respondent-Ip': '203.0.113.7', ...(init.headers as Record<string, string> | undefined), ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, headers);
  const authed = (session: string) => ({ Authorization: `Bearer ${session}` });
  return { ...app, call, post, authed };
}

async function start(p: ReturnType<typeof portal>, publicId: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<StartSessionResult> {
  const res = await p.post(`/f/${publicId}/sessions`, body, headers);
  expect(res.status).toBe(201);
  return data<StartSessionResult>(res);
}

const submit = (p: ReturnType<typeof portal>, session: StartSessionResult, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  p.post('/sessions/submit', { answers, ...extra }, p.authed(session.session), 'POST');

/** A quiz: a scored question with its answer marked, and a group with a multi-select one and a scored one without an answer. */
function quizDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [
      {
        id: 'b_planet',
        ref: 'planet',
        type: 'multiple_choice',
        title: 'Closest to the sun?',
        required: true,
        properties: { choices: [{ id: 'c_mercury', label: 'Mercury', score: 1, correct: true }, { id: 'c_mars', label: 'Mars', score: 0 }] },
      },
      {
        id: 'g_more',
        ref: 'more',
        type: 'group',
        title: 'Two more',
        children: [
          {
            id: 'b_rocky',
            ref: 'rocky',
            type: 'multiple_choice',
            title: 'Which are rocky?',
            properties: { multiple: true, choices: [{ id: 'c_venus', label: 'Venus', correct: true }, { id: 'c_earth', label: 'Earth', correct: true }, { id: 'c_saturn', label: 'Saturn' }] },
          },
          { id: 'b_fun', ref: 'fun', type: 'dropdown', title: 'Was this fun?', properties: { choices: [{ id: 'c_yes', label: 'Yes', score: 1 }] } },
        ],
      },
    ],
    endings: [{ id: 'e_done', ref: 'done', title: 'Score {{var:score}}', showScore: true, showAnswers: true }],
  });
}

/** Runs on TypeScript only in conformance mode (parallel requests, or a race set up inside the service). */
const itTypeScriptOnly = it.skipIf(Boolean(conformanceTarget()));

/** A session of a verified-email form, as `email` (the code is read from the last mail). */
async function verifiedSession(p: ReturnType<typeof portal>, publicId: string, email: string): Promise<StartSessionResult> {
  await p.post(`/f/${publicId}/send-code`, { email });
  const code = /\b(\d{6})\b/.exec(mail.transport!.sent.at(-1)!.text ?? '')![1]!;
  const { verification } = await data<{ verification: string }>(await p.post(`/f/${publicId}/verify`, { email, code }));
  return start(p, publicId, { verification });
}

/**
 * Runs `call` on a tenant handle that, right before its first transaction
 * (the submit's write), lets `other` run to the end on the real one: as if
 * both arrived together and `other` committed in between.
 */
async function whileRacing<T>(other: () => Promise<unknown>, call: () => Promise<T>): Promise<T> {
  let raced = false;
  const handle = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'transaction' || raced) return value.bind(target);
      return async (...args: unknown[]) => {
        raced = true;
        dbs.tenant = db;
        await other();
        return value.apply(target, args);
      };
    },
  });
  dbs.tenant = handle;
  try {
    return await call();
  } finally {
    dbs.tenant = db;
  }
}

/**
 * A tenant handle whose first read of a response answers `row` as it was:
 * a read taken before another call (a submit) wrote it.
 */
function staleRead(row: unknown): Database {
  let used = false;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'select') return value.bind(target);
      return (...args: unknown[]) => {
        const real = value.apply(target, args) as { from: (table: unknown) => unknown };
        return {
          from: (table: unknown) => {
            if (used || table !== schema.formResponses) return real.from(table);
            used = true;
            const read: Promise<unknown[]> & { where: () => unknown; limit: () => unknown } = Object.assign(Promise.resolve([row]), {
              where: () => read,
              limit: () => read,
            });
            return read;
          },
        };
      };
    },
  });
}

// ── The portal key ───────────────────────────────────────────────────────────

describe('the portal key', () => {
  it('answers 503 while FORMS_PORTAL_SECRET is unset, 403 without or with a wrong key', async () => {
    const { publicId } = await publish(simpleDefinition());
    const noSecret = portalApp(newWorld({ FORMS_PORTAL_SECRET: undefined }).env);
    expect((await noSecret.request(`${PUBLIC}/f/${publicId}`, { headers: { 'X-Forms-Portal-Key': PORTAL_KEY } })).status).toBe(503);

    const p = portalApp(world.env);
    expect((await p.request(`${PUBLIC}/f/${publicId}`)).status).toBe(403);
    expect((await p.request(`${PUBLIC}/f/${publicId}`, { headers: { 'X-Forms-Portal-Key': 'wrong' } })).status).toBe(403);
    expect((await p.request(`${PUBLIC}/f/${publicId}`, { headers: { 'X-Forms-Portal-Key': PORTAL_KEY } })).status).toBe(200);
    const denied = await p.request(`${PUBLIC}/sessions/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(403);
  });
});

// ── The public form ──────────────────────────────────────────────────────────

describe('GET /f/:publicId', () => {
  it('serves the published version from the cache without opening the tenant database', async () => {
    const { form, publicId } = await publish(surveyDefinition());
    dbs.tenantOpened = 0;
    const res = await portal().call(`/f/${publicId}`);
    expect(res.status).toBe(200);
    const body = await data<PublicForm>(res);
    expect(body).toMatchObject({
      publicId,
      title: 'Survey',
      state: 'open',
      respondentMode: 'anyone',
      versionId: form.publishedVersion!.id,
      botCheck: { provider: 'none', siteKey: null },
      branding: { workspaceName: 'Acme Staffing', showBadge: true },
      membersUrl: null,
    });
    expect(body.definition!.blocks.map((b) => b.id)).toEqual(['b_name', 'b_note', 'b_plan', 'b_extra']);
    expect(dbs.tenantOpened).toBe(0);
  });

  it('rebuilds a missing cache entry from the tenant', async () => {
    const { publicId } = await publish(simpleDefinition());
    await world.kv.delete(`forms:public:${publicId}`);
    dbs.tenantOpened = 0;
    expect((await data<PublicForm>(await portal().call(`/f/${publicId}`))).state).toBe('open');
    expect(dbs.tenantOpened).toBe(1);
    expect(await world.kv.get(`forms:public:${publicId}`)).not.toBeNull();
  });

  it('answers 404 for an unknown id and gives the Turnstile site key to the portal', async () => {
    expect((await portal().call('/f/nope123456')).status).toBe(404);
    const w = newWorld({ BOT_CHECK_PROVIDER: 'turnstile', TURNSTILE_SITE_KEY: '0xSITE' });
    const { publicId } = await publish(simpleDefinition(), {}, w);
    expect((await data<PublicForm>(await portal(w).call(`/f/${publicId}`))).botCheck).toEqual({ provider: 'turnstile', siteKey: '0xSITE' });
  });

  it('computes closed, not-yet-open, past close date, limit reached, suspended and held; closed forms give no definition', async () => {
    const { form, publicId } = await publish(simpleDefinition(), { closedMessage: 'See you in June' });
    const members = memberApp(FORMS, formsRoutes, world, db);
    const state = async () => data<PublicForm>(await portal().call(`/f/${publicId}`));
    expect(await state()).toMatchObject({ state: 'open' });

    await members.request(`${FORMS}/${form.id}/close`, json({}));
    expect(await state()).toMatchObject({ state: 'closed', definition: null, closedMessage: 'See you in June' });
    await members.request(`${FORMS}/${form.id}/reopen`, json({}));

    const patch = (settings: Record<string, unknown>, revision: number) => members.request(`${FORMS}/${form.id}`, json({ revision, settings }, 'PATCH'));
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await patch({ opensAt: future }, 2);
    expect((await state()).state).toBe('not_open_yet');
    await patch({ opensAt: null, closesAt: past }, 3);
    expect((await state()).state).toBe('past_close_date');
    await patch({ closesAt: null, responseLimit: 1 }, 4);
    expect((await state()).state).toBe('open');
    const p = portal();
    const session = await start(p, publicId);
    expect((await submit(p, session, { b_name: 'Ada' })).status).toBe(200);
    await p.settled();
    expect(await state()).toMatchObject({ state: 'limit_reached', definition: null });

    await master.update(masterSchema.formLinkRegistry).set({ suspendedAt: new Date() }).where(eq(masterSchema.formLinkRegistry.publicId, publicId));
    expect(await state()).toMatchObject({ state: 'suspended', definition: null });
    await master.update(masterSchema.formLinkRegistry).set({ suspendedAt: null, heldAt: new Date() }).where(eq(masterSchema.formLinkRegistry.publicId, publicId));
    expect((await state()).state).toBe('held');
  });

  it('points members-only forms at the platform fill page', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'members' });
    const body = await data<PublicForm>(await portal().call(`/f/${publicId}`));
    expect(body.respondentMode).toBe('members');
    expect(body.membersUrl).toBe(`https://app.test/w/${ORG}/weldforms/fill/${publicId}`);
  });

  it('serves the version a respondent started on when asked for it', async () => {
    const { form, publicId } = await publish(simpleDefinition());
    const v1 = form.publishedVersion!.id;
    const members = memberApp(FORMS, formsRoutes, world, db);
    await members.request(`${FORMS}/${form.id}`, json({ revision: form.revision, definition: { ...simpleDefinition(), welcome: { title: 'Version two' } } }, 'PATCH'));
    await members.request(`${FORMS}/${form.id}/publish`, json({}));
    const current = await data<PublicForm>(await portal().call(`/f/${publicId}`));
    expect(current.definition!.welcome?.title).toBe('Version two');
    const old = await data<PublicForm>(await portal().call(`/f/${publicId}?versionId=${v1}`));
    expect(old.versionId).toBe(v1);
    expect(old.definition!.welcome).toBeNull();
  });
});

describe('POST /f/:publicId/view', () => {
  it('counts a view once per browser tab key, in the counter store', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    expect(await data(await p.post(`/f/${publicId}/view`, { viewKey: 'tab-key-0001' }))).toEqual({ counted: true });
    expect(await data(await p.post(`/f/${publicId}/view`, { viewKey: 'tab-key-0001' }))).toEqual({ counted: false });
    expect(await data(await p.post(`/f/${publicId}/view`, { viewKey: 'tab-key-0002' }))).toEqual({ counted: true });
    expect((await p.post(`/f/${publicId}/view`, { viewKey: 'short' })).status).toBe(400);
    expect(await db.select().from(schema.formResponses)).toHaveLength(0);
  });

  it('rate limits views per IP, since the view key is the browser\'s own choice', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    holdClock();
    for (let i = 0; i < 30; i++) expect((await p.post(`/f/${publicId}/view`, { viewKey: `script-key-${i}` })).status).toBe(200);
    const limited = await p.post(`/f/${publicId}/view`, { viewKey: 'script-key-30' });
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('RATE_LIMITED');
    // Another address is not affected.
    expect(await data(await p.post(`/f/${publicId}/view`, { viewKey: 'office-key-1' }, { 'X-Respondent-Ip': '198.51.100.9' }))).toEqual({ counted: true });
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

describe('POST /f/:publicId/sessions', () => {
  it('starts a session and writes nothing to the tenant database', async () => {
    const { form, publicId } = await publish(surveyDefinition());
    const session = await start(portal(), publicId, { hidden: { utm_source: 'newsletter', unknown: 'x' }, metadata: { source: 'link', device: 'phone' } });
    expect(session).toMatchObject({ versionId: form.publishedVersion!.id, answers: {}, lastBlockId: null, respondentEmail: null, completed: null });
    expect(session.responseId).toMatch(/^frs_/);
    expect(session.hidden).toEqual({ utm_source: 'newsletter' });
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await db.select().from(schema.formResponses)).toHaveLength(0);
  });

  it('refuses without a passing bot check (Turnstile), and lets a verified token through', async () => {
    const w = newWorld({ BOT_CHECK_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: 'ts-secret' });
    const { publicId } = await publish(simpleDefinition(), {}, w);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = new URLSearchParams(init?.body as string).get('response');
      return new Response(JSON.stringify({ success: token === 'good-token' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = portal(w);

    const missing = await p.post(`/f/${publicId}/sessions`, {});
    expect(missing.status).toBe(403);
    expect((await errorOf(missing)).code).toBe('BOT_CHECK_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
    const bad = await p.post(`/f/${publicId}/sessions`, { botToken: 'bad-token' });
    expect(bad.status).toBe(403);
    // In conformance mode the stub answers both backends' calls.
    expect(fetchMock).toHaveBeenCalledTimes(conformanceTarget() ? 2 : 1);
    const good = await p.post(`/f/${publicId}/sessions`, { botToken: 'good-token' });
    expect(good.status).toBe(201);
    expect(String(fetchMock.mock.calls.at(-1)![1]!.body)).toContain('remoteip=203.0.113.7');
  });

  it('verifies an ALTCHA proof of work once, and refuses a replay or a wrong number', async () => {
    const w = newWorld({ BOT_CHECK_PROVIDER: 'altcha', ALTCHA_HMAC_KEY: 'altcha-key' });
    const { publicId } = await publish(simpleDefinition(), {}, w);
    const p = portal(w);
    const challenge = (await (await p.call('/altcha/challenge')).json()) as { algorithm: string; challenge: string; salt: string; signature: string; maxnumber: number };
    expect(challenge.algorithm).toBe('SHA-256');
    let solved = -1;
    for (let n = 0; n <= challenge.maxnumber; n++) {
      if ((await sha256Hex(`${challenge.salt}${n}`)) === challenge.challenge) {
        solved = n;
        break;
      }
    }
    expect(solved).toBeGreaterThanOrEqual(0);
    const encode = (number: number) => btoa(JSON.stringify({ ...challenge, number }));

    expect((await p.post(`/f/${publicId}/sessions`, { botToken: encode(solved + 1) })).status).toBe(403);
    expect((await p.post(`/f/${publicId}/sessions`, { botToken: encode(solved) })).status).toBe(201);
    expect((await p.post(`/f/${publicId}/sessions`, { botToken: encode(solved) })).status).toBe(403);
    expect(await createAltchaChallenge({ ALTCHA_HMAC_KEY: undefined })).toBeNull();
  });

  it('rate limits sessions per IP and form', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    holdClock();
    for (let i = 0; i < 10; i++) expect((await p.post(`/f/${publicId}/sessions`, {})).status).toBe(201);
    const limited = await p.post(`/f/${publicId}/sessions`, {});
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('RATE_LIMITED');
    // Another address is not affected.
    expect((await p.post(`/f/${publicId}/sessions`, {}, { 'X-Respondent-Ip': '198.51.100.9' })).status).toBe(201);
  });

  it('refuses a closed form and a members-only form', async () => {
    const closed = await publish(simpleDefinition());
    await master.update(masterSchema.formLinkRegistry).set({ suspendedAt: new Date() }).where(eq(masterSchema.formLinkRegistry.publicId, closed.publicId));
    const gone = await portal().post(`/f/${closed.publicId}/sessions`, {});
    expect(gone.status).toBe(403);
    expect((await errorOf(gone)).details).toMatchObject({ state: 'suspended' });

    const members = await publish(simpleDefinition(), { respondentMode: 'members' });
    const res = await portal().post(`/f/${members.publicId}/sessions`, {});
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('MEMBERS_ONLY');
  });

  it('resumes an earlier session with its saved answers (partial responses on)', async () => {
    const { publicId } = await publish(surveyDefinition(), { collectPartial: true });
    const p = portal();
    const first = await start(p, publicId);
    const saved = await p.post('/sessions/progress', { lastBlockId: 'b_plan', answers: { b_name: 'Ada', b_plan: { choiceIds: ['c_pro'] } } }, p.authed(first.session), 'PUT');
    expect(saved.status).toBe(200);
    const again = await start(p, publicId, { resume: first.session });
    expect(again).toMatchObject({ responseId: first.responseId, lastBlockId: 'b_plan', answers: { b_name: 'Ada', b_plan: { choiceIds: ['c_pro'] } } });
    // A token from another form is ignored: a new response starts.
    const other = await publish(simpleDefinition());
    expect((await start(p, other.publicId, { resume: first.session })).responseId).not.toBe(first.responseId);
  });

  it('keeps one response per browser as a soft limit', async () => {
    const { publicId } = await publish(simpleDefinition(), { onePerRespondent: true });
    const p = portal();
    const first = await start(p, publicId, { browserKey: 'browser-1' });
    expect((await submit(p, first, { b_name: 'Ada' })).status).toBe(200);
    const second = await start(p, publicId, { browserKey: 'browser-1' });
    expect(second).toMatchObject({ responseId: first.responseId, completed: { editable: false } });
    expect((await submit(p, second, { b_name: 'Again' })).status).toBe(409);
    const other = await start(p, publicId, { browserKey: 'browser-2' });
    expect(other.responseId).not.toBe(first.responseId);
    expect((await submit(p, other, { b_name: 'Grace' })).status).toBe(200);
    // Only a keyed hash of the browser key is stored.
    const rows = await db.select({ hash: schema.formResponses.respondentHash }).from(schema.formResponses);
    expect(rows.every((r) => r.hash && !r.hash.includes('browser'))).toBe(true);
  });
});

// ── Verified email ───────────────────────────────────────────────────────────

describe('verified-email forms', () => {
  const codeFrom = () => /\b(\d{6})\b/.exec(mail.transport!.sent.at(-1)!.text ?? '')![1]!;

  it('mails a code, verifies it and starts a session as that address', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email' });
    const p = portal();
    const needs = await p.post(`/f/${publicId}/sessions`, {});
    expect(needs.status).toBe(401);
    expect((await errorOf(needs)).code).toBe('VERIFICATION_REQUIRED');

    const sent = await p.post(`/f/${publicId}/send-code`, { email: 'Ada@Example.com' });
    expect(sent.status).toBe(200);
    expect(await data(sent)).toEqual({ expiresInSeconds: 600 });
    expect(mail.transport!.sent).toHaveLength(1);
    expect(mail.transport!.sent[0]!.to[0]!.email).toBe('Ada@Example.com');
    expect(mail.transport!.sent[0]!.subject).toContain('Survey');

    const { verification } = await data<{ verification: string }>(await p.post(`/f/${publicId}/verify`, { email: 'ada@example.com', code: codeFrom() }));
    const session = await start(p, publicId, { verification });
    expect(session.respondentEmail).toBe('ada@example.com');
    expect((await submit(p, session, { b_name: 'Ada' })).status).toBe(200);
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ respondentEmail: 'ada@example.com', status: 'completed' });
    expect(world.sent.find((m) => m.eventType === 'form_response:submitted')!.data).toMatchObject({ respondentEmail: 'ada@example.com' });
  });

  it('throttles resends, counts wrong codes and locks after five, even for the right code', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email' });
    const p = portal();
    await p.post(`/f/${publicId}/send-code`, { email: 'lock@example.com' });
    const again = await p.post(`/f/${publicId}/send-code`, { email: 'lock@example.com' });
    expect(again.status).toBe(429);
    expect((await errorOf(again)).code).toBe('RATE_LIMITED');

    const right = codeFrom();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let tries = 1; tries <= 4; tries++) {
      const res = await p.post(`/f/${publicId}/verify`, { email: 'lock@example.com', code: wrong });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: 'INVALID_CODE', details: { attemptsLeft: 5 - tries } });
    }
    const locking = await p.post(`/f/${publicId}/verify`, { email: 'lock@example.com', code: wrong });
    expect(locking.status).toBe(429);
    expect((await errorOf(locking)).code).toBe('LOCKED');
    const refused = await p.post(`/f/${publicId}/verify`, { email: 'lock@example.com', code: right });
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe('LOCKED');
    const send = await p.post(`/f/${publicId}/send-code`, { email: 'lock@example.com' });
    expect(send.status).toBe(429);
    // Another address is not locked.
    expect((await p.post(`/f/${publicId}/send-code`, { email: 'other@example.com' })).status).toBe(200);
  });

  it('needs a bot check to send a code, and only on verified-email forms', async () => {
    const w = newWorld({ BOT_CHECK_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: 'k' });
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email' }, w);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }))));
    const res = await portal(w).post(`/f/${publicId}/send-code`, { email: 'bot@example.com', botToken: 'x' });
    expect(res.status).toBe(403);
    expect(mail.transport!.sent).toHaveLength(0);

    const open = await publish(simpleDefinition());
    expect((await portal().post(`/f/${open.publicId}/send-code`, { email: 'a@example.com' })).status).toBe(400);
    expect((await portal().post(`/f/${open.publicId}/verify`, { email: 'a@example.com', code: '123456' })).status).toBe(400);
  });

  it('keeps one response per email and lets the respondent edit a completed one when the form allows it', async () => {
    const { publicId } = await publish(surveyDefinition(), { respondentMode: 'verified_email', onePerRespondent: true, allowEdit: true, collectPartial: true });
    const p = portal();
    const verify = async () => {
      await p.post(`/f/${publicId}/send-code`, { email: 'ed@example.com' });
      const { verification } = await data<{ verification: string }>(await p.post(`/f/${publicId}/verify`, { email: 'ed@example.com', code: codeFrom() }));
      return verification;
    };
    const first = await start(p, publicId, { verification: await verify() });
    expect((await submit(p, first, { b_name: 'Ed', b_plan: { choiceIds: ['c_pro'] }, b_extra: 'Support' })).status).toBe(200);

    for (const key of [...world.kv.store.keys()]) if (key.startsWith('forms:sent:')) world.kv.store.delete(key);
    const again = await start(p, publicId, { verification: await verify() });
    expect(again).toMatchObject({ responseId: first.responseId, completed: { editable: true }, answers: { b_name: 'Ed' } });
    world.sent.length = 0;
    const edited = await submit(p, again, { b_name: 'Edward', b_plan: { choiceIds: ['c_pro'] } });
    expect(edited.status).toBe(200);
    expect(eventNames(world.sent)).toEqual(['form_response:updated']);
    const rows = await db.select().from(schema.formResponses);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answers).toMatchObject({ b_name: 'Edward' });
    expect(rows[0]!.number).toBe(1);
    const [counted] = await db.select().from(schema.forms);
    expect(counted!.responseCount).toBe(1);
  });
});

// ── Progress and uploads ─────────────────────────────────────────────────────

describe('PUT /sessions/progress', () => {
  it('creates the response on the first save and keeps progress only unless the form collects partials', async () => {
    const { publicId } = await publish(surveyDefinition(), {}, world);
    const p = portal();
    const session = await start(p, publicId, { hidden: { utm_source: 'qr' }, metadata: { source: 'qr' } });
    expect(await db.select().from(schema.formResponses)).toHaveLength(0);

    const saved = await p.post('/sessions/progress', { lastBlockId: 'b_plan', answers: { b_name: 'Ada' }, timings: { b_name: 1200 } }, p.authed(session.session), 'PUT');
    expect(saved.status).toBe(200);
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ id: session.responseId, status: 'in_progress', lastBlockId: 'b_plan', answers: {}, hidden: { utm_source: 'qr' }, number: null });
    expect(row!.metadata).toMatchObject({ source: 'qr', timings: { b_name: 1200 } });
    expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.ipHash).not.toContain('203');

    await p.post('/sessions/progress', { lastBlockId: 'b_extra', timings: { b_name: 300, b_plan: 800 } }, p.authed(session.session), 'PUT');
    const [again] = await db.select().from(schema.formResponses);
    expect(again!.lastBlockId).toBe('b_extra');
    expect(again!.metadata.timings).toEqual({ b_name: 1500, b_plan: 800 });
    expect(await db.select().from(schema.formResponses)).toHaveLength(1);
  });

  it('stores only valid answers of the version when the form collects partial responses', async () => {
    const { publicId } = await publish(surveyDefinition(), { collectPartial: true });
    const p = portal();
    const session = await start(p, publicId);
    await p.post('/sessions/progress', { lastBlockId: 'b_plan', answers: { b_name: 'Ada', b_plan: { choiceIds: ['c_nope'] }, ghost: 'x' } }, p.authed(session.session), 'PUT');
    const [row] = await db.select().from(schema.formResponses);
    expect(row!.answers).toEqual({ b_name: 'Ada' });
    expect(row!.answeredCount).toBe(1);
  });

  it('refuses a missing, forged or expired session (401)', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    const body = { lastBlockId: 'b_name' };
    expect((await p.post('/sessions/progress', body, {}, 'PUT')).status).toBe(401);
    expect((await p.post('/sessions/progress', body, { Authorization: 'Bearer abc.def' }, 'PUT')).status).toBe(401);
    const session = await start(p, publicId);
    const [payload, sig] = session.session.split('.');
    const forged = `${btoa(JSON.stringify({ ...JSON.parse(atob(payload!.replaceAll('-', '+').replaceAll('_', '/'))), resp: 'frs_other' })).replaceAll('=', '')}.${sig}`;
    expect((await p.post('/sessions/progress', body, { Authorization: `Bearer ${forged}` }, 'PUT')).status).toBe(401);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86_400_000);
    expect((await p.post('/sessions/progress', body, p.authed(session.session), 'PUT')).status).toBe(401);
    spy.mockRestore();
    expect((await p.post('/sessions/progress', body, p.authed(session.session), 'PUT')).status).toBe(200);
  });

  it('marks a personal invitation started and stops saving once the response is completed', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    const session = await start(p, publicId);
    await p.post('/sessions/progress', { lastBlockId: 'b_name' }, p.authed(session.session), 'PUT');
    expect((await submit(p, session, { b_name: 'Ada' })).status).toBe(200);
    expect((await p.post('/sessions/progress', { lastBlockId: 'b_name', answers: { b_name: 'Changed' } }, p.authed(session.session), 'PUT')).status).toBe(200);
    const [row] = await db.select().from(schema.formResponses);
    expect(row!.answers).toEqual({ b_name: 'Ada' });
  });

  itTypeScriptOnly('leaves the completed answers alone when a save that read the response before the submit writes after it', async () => {
    const { publicId } = await publish(surveyDefinition(), { collectPartial: true });
    const p = portal();
    const session = await start(p, publicId);
    await p.post('/sessions/progress', { lastBlockId: 'b_plan', answers: { b_name: 'Draft' } }, p.authed(session.session), 'PUT');
    const [inProgress] = await db.select().from(schema.formResponses);
    expect((await submit(p, session, { b_name: 'Ada', b_plan: { choiceIds: ['c_free'] } })).status).toBe(200);
    await p.settled();

    dbs.tenant = staleRead(inProgress!);
    try {
      const late = await p.post('/sessions/progress', { lastBlockId: 'b_extra', answers: { b_name: 'Late' } }, p.authed(session.session), 'PUT');
      expect(late.status).toBe(200);
    } finally {
      dbs.tenant = db;
    }
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ status: 'completed', answers: { b_name: 'Ada', b_plan: { choiceIds: ['c_free'] } } });
    expect(row!.lastBlockId).not.toBe('b_extra');
  });
});

describe('POST /sessions/uploads', () => {
  const upload = (p: ReturnType<typeof portal>, session: StartSessionResult, blockId: string, file: File) => {
    const form = new FormData();
    form.append('blockId', blockId);
    form.append('file', file);
    return p.call('/sessions/uploads', { method: 'POST', body: form }, p.authed(session.session));
  };
  const pdf = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });

  it('stores a file under the pending prefix with a row, and enforces type, size and count', async () => {
    const { form, publicId } = await publish(uploadDefinition());
    const p = portal();
    const session = await start(p, publicId);

    const ok = await upload(p, session, 'b_cv', pdf('cv.pdf', 20));
    expect(ok.status).toBe(201);
    const { file } = await data<{ file: { fileId: string; name: string; size: number; type: string } }>(ok);
    expect(file).toMatchObject({ name: 'cv.pdf', size: 20, type: 'application/pdf' });
    const [row] = await db.select().from(schema.formResponseFiles);
    expect(row).toMatchObject({ id: file.fileId, responseId: session.responseId, formId: form.id, blockId: 'b_cv', kind: 'upload', storageKey: `weldforms/pending/${session.responseId}/${file.fileId}` });
    expect(await world.privateBucket.get(row!.storageKey)).not.toBeNull();

    const wrongType = await upload(p, session, 'b_cv', new File(['x'], 'a.png', { type: 'image/png' }));
    expect(wrongType.status).toBe(415);
    const tooBig = await upload(p, session, 'b_cv', pdf('big.pdf', 1024 * 1024 + 1));
    expect(tooBig.status).toBe(413);
    expect((await upload(p, session, 'b_cv', pdf('b.pdf'))).status).toBe(201);
    const third = await upload(p, session, 'b_cv', pdf('c.pdf'));
    expect(third.status).toBe(422);
    expect((await errorOf(third)).code).toBe('TOO_MANY_FILES');
    expect((await upload(p, session, 'b_name', pdf('x.pdf'))).status).toBe(400);
    expect((await upload(p, session, 'b_missing', pdf('x.pdf'))).status).toBe(400);
    expect(await db.select().from(schema.formResponseFiles)).toHaveLength(2);
  });

  it('takes a drawn signature as PNG and replaces the previous one', async () => {
    const { publicId } = await publish(uploadDefinition());
    const p = portal();
    const session = await start(p, publicId);
    const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
    expect((await upload(p, session, 'b_sign', pdf('sig.pdf'))).status).toBe(415);
    expect((await upload(p, session, 'b_sign', png('one.png'))).status).toBe(201);
    expect((await upload(p, session, 'b_sign', png('two.png'))).status).toBe(201);
    const rows = await db.select().from(schema.formResponseFiles);
    expect(rows.map((r) => [r.kind, r.name])).toEqual([['signature', 'two.png']]);
  });

  const pngFile = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
  const uploaded = async (p: ReturnType<typeof portal>, session: StartSessionResult, blockId: string, file: File) => {
    const res = await upload(p, session, blockId, file);
    expect(res.status).toBe(201);
    return (await data<{ file: { fileId: string; name: string; size: number; type: string } }>(res)).file;
  };

  it('refuses an upload once the response is submitted, and leaves the submitted files alone', async () => {
    const { publicId } = await publish(uploadDefinition());
    const p = portal();
    const session = await start(p, publicId);
    const cv = await uploaded(p, session, 'b_cv', pdf('cv.pdf'));
    const sign = await uploaded(p, session, 'b_sign', pngFile('sign.png'));
    expect((await submit(p, session, { b_name: 'Ada', b_cv: [cv], b_sign: sign })).status).toBe(200);
    await p.settled();
    const submitted = await db.select().from(schema.formResponseFiles);

    for (const [blockId, file] of [['b_sign', pngFile('again.png')], ['b_cv', pdf('more.pdf')]] as const) {
      const late = await upload(p, session, blockId, file);
      expect([late.status, (await errorOf(late)).code]).toEqual([409, 'ALREADY_SUBMITTED']);
    }
    expect(await db.select().from(schema.formResponseFiles)).toEqual(submitted);
    for (const row of submitted) expect(await world.privateBucket.get(row.storageKey)).not.toBeNull();
  });

  it('stages an edit\'s files next to the submitted ones, and the edit drops the ones it replaced', async () => {
    const definition = uploadDefinition();
    definition.blocks = definition.blocks.map((b) => (b.id === 'b_cv' ? { ...b, properties: { ...(b as { properties: object }).properties, maxFiles: 1 } } : b)) as FormDefinition['blocks'];
    const { form, publicId } = await publish(definition, { respondentMode: 'verified_email', allowEdit: true });
    const p = portal();
    const session = await verifiedSession(p, publicId, 'ed@example.com');
    const cv = await uploaded(p, session, 'b_cv', pdf('cv.pdf'));
    const sign = await uploaded(p, session, 'b_sign', pngFile('one.png'));
    expect((await submit(p, session, { b_name: 'Ed', b_cv: [cv], b_sign: sign })).status).toBe(200);
    await p.settled();
    const submitted = await db.select().from(schema.formResponseFiles);
    expect(submitted).toHaveLength(2);

    // The field takes one file: the new one is staged next to the submitted one, which stays until the edit is in.
    const newCv = await uploaded(p, session, 'b_cv', pdf('cv-2.pdf'));
    const newSign = await uploaded(p, session, 'b_sign', pngFile('two.png'));
    expect(await db.select().from(schema.formResponseFiles)).toHaveLength(4);
    for (const row of submitted) expect(await world.privateBucket.get(row.storageKey)).not.toBeNull();

    expect((await submit(p, session, { b_name: 'Ed', b_cv: [newCv], b_sign: newSign })).status).toBe(200);
    await p.settled();
    const rows = await db.select().from(schema.formResponseFiles);
    expect(rows.map((r) => r.id).sort()).toEqual([newCv.fileId, newSign.fileId].sort());
    expect(rows.every((r) => r.storageKey.startsWith(`workspaces/${ORG}/weldforms/${form.id}/${session.responseId}/`))).toBe(true);
    for (const row of submitted) expect(await world.privateBucket.get(row.storageKey)).toBeNull();
    const [response] = await db.select().from(schema.formResponses);
    expect(response!.answers).toMatchObject({ b_cv: [{ fileId: newCv.fileId }], b_sign: { fileId: newSign.fileId } });
  });
});

// ── Submit ───────────────────────────────────────────────────────────────────

describe('POST /sessions/submit', () => {
  it('answers 422 VALIDATION_FAILED with the failing fields', async () => {
    const { publicId } = await publish(surveyDefinition());
    const p = portal();
    const session = await start(p, publicId);
    const res = await submit(p, session, { b_plan: { choiceIds: ['c_pro'] } });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ fields: { b_name: { code: 'required' } } });
    expect(await db.select().from(schema.formResponses)).toHaveLength(0);

    const bad = await submit(p, session, { b_name: 'Ada', b_plan: { choiceIds: ['c_ghost'] } });
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).details).toEqual({ fields: { b_plan: { code: 'invalid_choice' } } });
  });

  it('completes the response: numbers it, recomputes score and ending, fills recall, drops skipped answers', async () => {
    const { form, publicId } = await publish(surveyDefinition());
    const p = portal();
    const session = await start(p, publicId, { hidden: { utm_source: 'newsletter' }, metadata: { source: 'link' } });
    const res = await submit(p, session, {
      b_name: 'Ada',
      b_note: 'Do not share',
      b_plan: { choiceIds: ['c_free'] },
      b_extra: 'Skipped by the jump, so dropped',
      ghost: 'unknown block',
    });
    expect(res.status).toBe(200);
    const result = await data<SubmitSessionResult>(res);
    expect(result).toMatchObject({ responseId: session.responseId, number: 1, score: 1, quiz: null });
    expect(result.ending).toMatchObject({ id: 'e_done', title: 'Thanks Ada! Score 1', description: null, redirectUrl: null, button: null, showScore: true, showAnswers: false });

    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({
      id: session.responseId,
      formId: form.id,
      versionId: form.publishedVersion!.id,
      number: 1,
      status: 'completed',
      endingId: 'e_done',
      score: 1,
      hidden: { utm_source: 'newsletter' },
      variables: { score: 1 },
      answeredCount: 3,
    });
    expect(row!.answers).toEqual({ b_name: 'Ada', b_note: 'Do not share', b_plan: { choiceIds: ['c_free'] } });
    expect(row!.searchText).toContain('ada');
    expect(row!.submittedAt).not.toBeNull();
    expect(row!.metadata).toMatchObject({ source: 'link' });
    const [counted] = await db.select().from(schema.forms);
    expect(counted).toMatchObject({ responseCount: 1, responseCounter: 1 });
    expect(counted!.lastResponseAt).not.toBeNull();
    // ProcessResponse starts once, with the response id as the instance id.
    expect(world.processed).toEqual([{ id: session.responseId, params: { clerkOrgId: ORG, workspaceId: WS, formId: form.id, responseId: session.responseId, mode: 'submit' } }]);
  });

  it('publishes form_response:submitted with answers by ref, without the sensitive ones', async () => {
    const { form, publicId } = await publish(surveyDefinition());
    const p = portal();
    const session = await start(p, publicId, { hidden: { utm_source: 'qr' } });
    await submit(p, session, { b_name: 'Ada', b_note: 'Do not share', b_plan: { choiceIds: ['c_pro'] }, b_extra: 'Support' });
    await p.settled();
    expect(eventNames(world.sent)).toEqual(['form_response:submitted']);
    const event = world.sent[0]!;
    expect(event.entityId).toBe(session.responseId);
    expect(event.metadata).toMatchObject({ workspaceId: ORG, userId: 'respondent' });
    expect(event.data).toMatchObject({
      id: session.responseId,
      formId: form.id,
      formTitle: 'Survey',
      number: 1,
      score: 5,
      endingId: 'e_done',
      respondentEmail: null,
      hidden: { utm_source: 'qr' },
      answers: { name: 'Ada', plan: 'Pro', extra: 'Support' },
    });
    expect(JSON.stringify(event.data)).not.toContain('Do not share');
    expect(Object.keys((event.data as { answers: object }).answers)).not.toContain('private_note');
  });

  it('numbers responses per form and refuses a second submit of the same session (409)', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    const first = await start(p, publicId);
    const second = await start(p, publicId);
    expect((await data<SubmitSessionResult>(await submit(p, first, { b_name: 'A' }))).number).toBe(1);
    expect((await data<SubmitSessionResult>(await submit(p, second, { b_name: 'B' }))).number).toBe(2);
    const dup = await submit(p, first, { b_name: 'A again' });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe('ALREADY_SUBMITTED');
    const [counted] = await db.select().from(schema.forms);
    expect(counted).toMatchObject({ responseCount: 2, responseCounter: 2 });
  });

  // The race is set up inside the TypeScript service (a tenant handle that lets the other call in).
  itTypeScriptOnly('counts a double submit of one session once: the call that loses the race is refused', async () => {
    const { publicId } = await publish(simpleDefinition(), { responseLimit: 5 });
    const p = portal();
    const session = await start(p, publicId);
    let first: Response | undefined;
    const late = await whileRacing(async () => void (first = await submit(p, session, { b_name: 'Ada' })), () => submit(p, session, { b_name: 'Ada' }));
    await p.settled();
    expect([first!.status, late.status]).toEqual([200, 409]);
    expect((await errorOf(late)).code).toBe('ALREADY_SUBMITTED');
    const [counted] = await db.select().from(schema.forms);
    expect(counted).toMatchObject({ responseCount: 1, responseCounter: 1 });
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ status: 'completed', number: 1 });
    expect(eventNames(world.sent)).toEqual(['form_response:submitted']);
    expect(world.processed).toHaveLength(1);
  });

  itTypeScriptOnly('turns the call that loses a double submit into an edit when the form allows edits', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email', allowEdit: true });
    const p = portal();
    const session = await verifiedSession(p, publicId, 'ed@example.com');
    world.sent.length = 0;
    let first: Response | undefined;
    const late = await whileRacing(async () => void (first = await submit(p, session, { b_name: 'Ed' })), () => submit(p, session, { b_name: 'Edward' }));
    await p.settled();
    expect([first!.status, late.status]).toEqual([200, 200]);
    expect((await data<SubmitSessionResult>(late)).number).toBe(1);
    const [counted] = await db.select().from(schema.forms);
    expect(counted).toMatchObject({ responseCount: 1, responseCounter: 1 });
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ number: 1, answers: { b_name: 'Edward' } });
    expect(eventNames(world.sent)).toEqual(['form_response:submitted', 'form_response:updated']);
    expect(world.processed.map((r) => (r.params as { mode: string }).mode)).toEqual(['submit', 'update']);
  });

  it('rejects a filled honeypot and a submission faster than a person', async () => {
    const { publicId } = await publish(simpleDefinition());
    const p = portal();
    const bot = await start(p, publicId);
    const trap = await submit(p, bot, { b_name: 'Bot' }, { website: 'https://spam.example' });
    expect(trap.status).toBe(400);
    expect((await errorOf(trap)).code).toBe('SUBMISSION_REJECTED');

    const w = newWorld({ FORMS_MIN_FILL_MS: '60000' });
    const slow = await publish(simpleDefinition(), {}, w);
    const fast = portal(w);
    const session = await start(fast, slow.publicId);
    const quick = await submit(fast, session, { b_name: 'Too fast' });
    expect(quick.status).toBe(400);
    expect(await db.select().from(schema.formResponses).where(eq(schema.formResponses.status, 'completed'))).toHaveLength(0);
  });

  it('moves uploads to the form folder, refuses another response\'s file and drops unused ones', async () => {
    const { form, publicId } = await publish(uploadDefinition());
    const p = portal();
    const session = await start(p, publicId);
    const up = async (name: string) => {
      const body = new FormData();
      body.append('blockId', 'b_cv');
      body.append('file', new File([new Uint8Array(8)], name, { type: 'application/pdf' }));
      return (await data<{ file: { fileId: string; name: string; size: number; type: string } }>(await p.call('/sessions/uploads', { method: 'POST', body }, p.authed(session.session)))).file;
    };
    const kept = await up('cv.pdf');
    const unused = await up('old.pdf');

    // Another session's file id is refused for this response.
    const other = await start(p, publicId);
    const stranger = await (async () => {
      const body = new FormData();
      body.append('blockId', 'b_cv');
      body.append('file', new File([new Uint8Array(8)], 'theirs.pdf', { type: 'application/pdf' }));
      return (await data<{ file: { fileId: string; name: string; size: number; type: string } }>(await p.call('/sessions/uploads', { method: 'POST', body }, p.authed(other.session)))).file;
    })();
    const refused = await submit(p, session, { b_name: 'Ada', b_cv: [stranger] });
    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).details).toEqual({ fields: { b_cv: { code: 'invalid' } } });

    const res = await submit(p, session, { b_name: 'Ada', b_cv: [{ ...kept, name: 'spoofed.exe', size: 1 }] });
    expect(res.status).toBe(200);
    await p.settled();
    const rows = await db.select().from(schema.formResponseFiles).where(eq(schema.formResponseFiles.responseId, session.responseId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: kept.fileId, name: 'cv.pdf', sizeBytes: 8 });
    expect(rows[0]!.storageKey).toBe(`workspaces/${ORG}/weldforms/${form.id}/${session.responseId}/${kept.fileId}-cv.pdf`);
    expect(await world.privateBucket.get(rows[0]!.storageKey)).not.toBeNull();
    expect(await world.privateBucket.get(`weldforms/pending/${session.responseId}/${kept.fileId}`)).toBeNull();
    expect(await world.privateBucket.get(`weldforms/pending/${session.responseId}/${unused.fileId}`)).toBeNull();
    const [stored] = await db.select().from(schema.formResponses).where(eq(schema.formResponses.id, session.responseId));
    expect(stored!.answers).toMatchObject({ b_cv: [{ fileId: kept.fileId, name: 'cv.pdf', size: 8 }] });
    // File names are never put on the event bus.
    expect(JSON.stringify(world.sent.map((m) => m.data))).not.toContain('cv.pdf');
  });

  it('refuses once the form is closed or full, and a staff-suspended form', async () => {
    const { form, publicId } = await publish(simpleDefinition(), { responseLimit: 1 });
    const p = portal();
    const a = await start(p, publicId);
    const b = await start(p, publicId);
    expect((await submit(p, a, { b_name: 'A' })).status).toBe(200);
    const full = await submit(p, b, { b_name: 'B' });
    expect(full.status).toBe(403);
    expect((await errorOf(full)).details).toMatchObject({ state: 'limit_reached' });

    const members = memberApp(FORMS, formsRoutes, world, db);
    const open = await publish(simpleDefinition());
    const c = await start(p, open.publicId);
    await members.request(`${FORMS}/${open.form.id}/close`, json({}));
    expect((await submit(p, c, { b_name: 'C' })).status).toBe(403);
    await members.request(`${FORMS}/${open.form.id}/reopen`, json({}));
    await master.update(masterSchema.formLinkRegistry).set({ suspendedAt: new Date() }).where(eq(masterSchema.formLinkRegistry.publicId, open.publicId));
    expect((await submit(p, c, { b_name: 'C' })).status).toBe(403);
    expect(form.id).toBeTruthy();
  });

  it('fills recall and a redirect URL of the ending, and shows the quiz when the ending asks for it', async () => {
    const definition = surveyDefinition();
    definition.endings = [{ id: 'e_done', ref: 'thanks', title: 'Hi {{field:name}}', description: 'Plan: {{field:plan}}', showScore: true, showAnswers: true, redirectUrl: 'https://example.com/thanks?n={{field:name}}&s={{var:score}}', button: { text: 'More', url: 'https://example.com/{{hidden:utm_source}}' } }];
    definition.blocks = definition.blocks.map((b) => (b.id === 'b_plan' ? { ...b, properties: { ...(b as { properties: object }).properties, choices: [{ id: 'c_free', label: 'Free', score: 1 }, { id: 'c_pro', label: 'Pro', score: 5, correct: true }] } } : b)) as FormDefinition['blocks'];
    const { publicId } = await publish(definition);
    const p = portal();
    const session = await start(p, publicId, { hidden: { utm_source: 'a b' } });
    const result = await data<SubmitSessionResult>(await submit(p, session, { b_name: 'Ada Lovelace', b_plan: { choiceIds: ['c_pro'] }, b_extra: 'x' }));
    expect(result.ending).toMatchObject({
      title: 'Hi Ada Lovelace',
      description: 'Plan: Pro',
      redirectUrl: 'https://example.com/thanks?n=Ada%20Lovelace&s=5',
      button: { text: 'More', url: 'https://example.com/a%20b' },
    });
    expect(result.quiz).toEqual([{ fieldId: 'b_plan', correct: true, points: 5, correctAnswer: 'Pro' }]);
  });

  it('gives respondents the form without the quiz\'s answer key, and names the right answer in the result', async () => {
    const { publicId } = await publish(quizDefinition());
    const p = portal();
    const form = await data<PublicForm>(await p.call(`/f/${publicId}`));
    expect(JSON.stringify(form.definition)).not.toContain('"correct"');
    // The scores stay: logic and {score} recall run in the browser.
    expect((form.definition!.blocks[0] as { properties: { choices: unknown[] } }).properties.choices).toEqual([
      { id: 'c_mercury', label: 'Mercury', score: 1 },
      { id: 'c_mars', label: 'Mars', score: 0 },
    ]);

    const session = await start(p, publicId);
    const result = await data<SubmitSessionResult>(
      await submit(p, session, { b_planet: { choiceIds: ['c_mars'] }, b_rocky: { choiceIds: ['c_venus', 'c_earth'] }, b_fun: { choiceIds: ['c_yes'] } }),
    );
    expect(result.quiz).toEqual([
      { fieldId: 'b_planet', correct: false, points: 0, correctAnswer: 'Mercury' },
      { fieldId: 'b_rocky', correct: true, points: 0, correctAnswer: 'Venus, Earth' },
      { fieldId: 'b_fun', correct: null, points: 1, correctAnswer: null },
    ]);

    // The members-only page gets the same payload.
    const members = await publish(quizDefinition(), { respondentMode: 'members' });
    const fill = memberApp('/api/forms/fill', fillRoutes, world, db, { userId: 'user_a', permissions: [] });
    const filled = await data<{ form: PublicForm }>(await fill.request(`/api/forms/fill/${members.publicId}`));
    expect(filled.form.definition).not.toBeNull();
    expect(JSON.stringify(filled.form.definition)).not.toContain('"correct"');
  });
});

// ── Plan quota ───────────────────────────────────────────────────────────────

describe('plan quota', () => {
  it('stops new sessions over the monthly quota but lets a started one submit, then flags the cache', async () => {
    const { form, publicId } = await publish(simpleDefinition());
    const p = portal();
    const started = await start(p, publicId);

    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `frs_q${i}`, formId: form.id, versionId: form.publishedVersion!.id, status: 'completed' as const, number: i + 1, submittedAt: new Date() }));
    await db.insert(schema.formResponses).values(rows);
    await db.update(schema.forms).set({ responseCount: 100, responseCounter: 100 }).where(eq(schema.forms.id, form.id));

    // The grace: this respondent was already in the form.
    const res = await submit(p, started, { b_name: 'Late but fine' });
    expect(res.status).toBe(200);
    expect((await data<SubmitSessionResult>(res)).number).toBe(101);
    await p.settled();

    const gate = await data<PublicForm>(await p.call(`/f/${publicId}`));
    expect(gate).toMatchObject({ state: 'over_quota', definition: null });
    const refused = await p.post(`/f/${publicId}/sessions`, {});
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({ code: 'FORM_CLOSED', details: { state: 'over_quota' } });
    // The cache entry remembers the month it was over, so next month it opens again.
    const entry = JSON.parse((await world.kv.get(`forms:public:${publicId}`))!) as { overQuotaMonth: string };
    expect(entry.overQuotaMonth).toBe(new Date().toISOString().slice(0, 7));
    const earlier = { ...entry, overQuotaMonth: '2020-01' };
    await world.kv.put(`forms:public:${publicId}`, JSON.stringify(earlier));
    expect((await data<PublicForm>(await p.call(`/f/${publicId}`))).state).toBe('open');
  });

  it('does not limit a paid plan below its quota', async () => {
    await seedWorkspace(master, 'pro');
    const { form, publicId } = await publish(simpleDefinition());
    await db.insert(schema.formResponses).values(Array.from({ length: 150 }, (_, i) => ({ id: `frs_p${i}`, formId: form.id, versionId: 'fve_x', status: 'completed' as const, number: i + 1, submittedAt: new Date() })));
    await db.update(schema.forms).set({ responseCount: 150, responseCounter: 150 }).where(eq(schema.forms.id, form.id));
    const p = portal();
    const session = await start(p, publicId);
    expect((await submit(p, session, { b_name: 'Fine' })).status).toBe(200);
    await p.settled();
    expect((await data<PublicForm>(await p.call(`/f/${publicId}`))).state).toBe('open');
  });
});

// ── Abuse reports ────────────────────────────────────────────────────────────

describe('POST /f/:publicId/report', () => {
  it('records an abuse report in the master database', async () => {
    const { form, publicId } = await publish(simpleDefinition());
    const res = await portal().post(`/f/${publicId}/report`, { reason: 'phishing', details: 'Asks for my bank login', email: 'victim@example.com' });
    expect(res.status).toBe(201);
    const [report] = await master.select().from(masterSchema.formAbuseReports);
    expect(report).toMatchObject({ publicId, workspaceId: WS, formId: form.id, reason: 'phishing', details: 'Asks for my bank login', reporterEmail: 'victim@example.com', status: 'open' });
    expect(report!.reporterIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await portal().post(`/f/${publicId}/report`, { reason: 'nonsense' })).status).toBe(400);
    expect((await portal().post('/f/missing123/report', { reason: 'spam' })).status).toBe(404);
  });
});

// ── Members-only forms ───────────────────────────────────────────────────────

describe('/api/forms/fill/:publicId', () => {
  const fill = (who: { userId: string; permissions?: string[] }, w: World = world) => memberApp('/api/forms/fill', fillRoutes, w, db, { userId: who.userId, permissions: who.permissions ?? [] });

  beforeEach(async () => {
    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_1', userId: 'user_a', email: 'a@acme.test', name: 'Alice', role: 'MEMBER' },
      { id: 'wm_2', userId: 'user_b', email: 'b@acme.test', name: 'Bob', role: 'MEMBER' },
    ]);
  });

  it('gives the form without a bot check, answers it once per member and ties the response to them', async () => {
    const { form, publicId } = await publish(surveyDefinition(), { respondentMode: 'members', onePerRespondent: true });
    const a = fill({ userId: 'user_a' });
    const got = await data<{ form: PublicForm; alreadyResponded: boolean }>(await a.request(`/api/forms/fill/${publicId}`));
    expect(got.alreadyResponded).toBe(false);
    expect(got.form).toMatchObject({ publicId, state: 'open', respondentMode: 'members', botCheck: { provider: 'none' }, membersUrl: null });
    expect(got.form.definition).not.toBeNull();

    const answers = { b_name: 'Alice', b_plan: { choiceIds: ['c_pro'] } };
    const res = await a.request(`/api/forms/fill/${publicId}`, json({ answers, hidden: { utm_source: 'intranet' } }));
    expect(res.status).toBe(201);
    expect(await data<SubmitSessionResult>(res)).toMatchObject({ number: 1, score: 5 });
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ formId: form.id, status: 'completed', respondentUserId: 'user_a', respondentEmail: 'a@acme.test', respondentHash: null, hidden: { utm_source: 'intranet' } });
    expect(row!.metadata).toMatchObject({ source: 'members' });
    expect(eventNames(world.sent)).toEqual(['form_response:submitted']);
    expect(world.sent[0]!.metadata.userId).toBe('user_a');

    expect((await data<{ alreadyResponded: boolean }>(await a.request(`/api/forms/fill/${publicId}`))).alreadyResponded).toBe(true);
    const again = await a.request(`/api/forms/fill/${publicId}`, json({ answers }));
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('ALREADY_SUBMITTED');
    // Bob is a different member; his answers go through the same validation.
    const invalid = await fill({ userId: 'user_b' }).request(`/api/forms/fill/${publicId}`, json({ answers: { b_plan: { choiceIds: ['c_pro'] } } }));
    expect(invalid.status).toBe(422);
    expect((await fill({ userId: 'user_b' }).request(`/api/forms/fill/${publicId}`, json({ answers }))).status).toBe(201);
  });

  it('stores no member id when the form hides identities, only a keyed hash that still enforces one response', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'members', onePerRespondent: true, hideMemberIdentity: true });
    const a = fill({ userId: 'user_a' });
    const res = await a.request(`/api/forms/fill/${publicId}`, json({ answers: { b_name: 'Anonymous' } }));
    expect(res.status).toBe(201);
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ respondentUserId: null, respondentEmail: null });
    expect(row!.respondentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('user_a');
    expect(world.sent[0]!.metadata.userId).toBe('respondent');
    expect(JSON.stringify(world.sent)).not.toContain('user_a');
    expect((await a.request(`/api/forms/fill/${publicId}`, json({ answers: { b_name: 'Again' } }))).status).toBe(409);
    expect((await data<{ alreadyResponded: boolean }>(await a.request(`/api/forms/fill/${publicId}`))).alreadyResponded).toBe(true);
    expect((await fill({ userId: 'user_b' }).request(`/api/forms/fill/${publicId}`, json({ answers: { b_name: 'Bob' } }))).status).toBe(201);
  });

  it('is a 404 for a form that is not members-only or belongs to another workspace', async () => {
    const open = await publish(simpleDefinition());
    expect((await fill({ userId: 'user_a' }).request(`/api/forms/fill/${open.publicId}`)).status).toBe(404);
    const members = await publish(simpleDefinition(), { respondentMode: 'members' });
    await master.update(masterSchema.formLinkRegistry).set({ workspaceId: 'ws_other' }).where(eq(masterSchema.formLinkRegistry.publicId, members.publicId));
    expect((await fill({ userId: 'user_a' }).request(`/api/forms/fill/${members.publicId}`)).status).toBe(404);
    expect((await fill({ userId: 'user_a' }).request('/api/forms/fill/nope123456')).status).toBe(404);
  });

  it('refuses a closed members-only form', async () => {
    const { form, publicId } = await publish(simpleDefinition(), { respondentMode: 'members' });
    await memberApp(FORMS, formsRoutes, world, db).request(`${FORMS}/${form.id}/close`, json({}));
    const res = await fill({ userId: 'user_a' }).request(`/api/forms/fill/${publicId}`, json({ answers: { b_name: 'Late' } }));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORM_CLOSED');
  });
});

// ── Personal invitation links ────────────────────────────────────────────────

describe('invitation links', () => {
  const TOKEN = 'invite-token-0123456789-abcdefghij';

  async function invite(formId: string, status: 'sent' | 'revoked' = 'sent') {
    await db.insert(schema.formInvitations).values({ id: 'fin_1', formId, email: 'guest@example.com', name: 'Guest', status, invitedByUserId: 'user_owner', sentAt: new Date() });
    await master.insert(masterSchema.formInvitationRegistry).values({
      id: 'fir_1',
      tokenHash: await sha256Hex(TOKEN),
      workspaceId: WS,
      clerkOrgId: ORG,
      formId,
      invitationId: 'fin_1',
      revokedAt: status === 'revoked' ? new Date() : null,
    });
  }

  it('opens as that person without a code or a bot check, and tracks opened, started and completed', async () => {
    const w = newWorld({ BOT_CHECK_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: 'k' });
    const { form, publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email' }, w);
    await invite(form.id);
    const p = portal(w);
    const session = await start(p, publicId, { invitationToken: TOKEN });
    expect(session.respondentEmail).toBe('guest@example.com');
    const [opened] = await db.select().from(schema.formInvitations);
    expect(opened).toMatchObject({ status: 'opened' });
    expect(opened!.openedAt).not.toBeNull();

    await p.post('/sessions/progress', { lastBlockId: 'b_name' }, p.authed(session.session), 'PUT');
    expect((await db.select().from(schema.formInvitations))[0]).toMatchObject({ status: 'started', responseId: session.responseId });

    expect((await submit(p, session, { b_name: 'Guest' })).status).toBe(200);
    expect((await db.select().from(schema.formInvitations))[0]).toMatchObject({ status: 'completed', responseId: session.responseId });
    const [response] = await db.select().from(schema.formResponses);
    expect(response).toMatchObject({ invitationId: 'fin_1', respondentEmail: 'guest@example.com', status: 'completed' });
    expect(eventNames(w.sent)).toEqual(['form_response:submitted', 'form_invitation:completed']);
    expect(w.sent[1]!.data).toMatchObject({ id: 'fin_1', formId: form.id, email: 'guest@example.com' });

    // Opening the link again finds the completed response.
    const again = await start(p, publicId, { invitationToken: TOKEN });
    expect(again).toMatchObject({ responseId: session.responseId, completed: { editable: false } });
  });

  it('refuses a revoked link (410), an unknown one (404) and one that belongs to another form', async () => {
    const { form, publicId } = await publish(simpleDefinition());
    await invite(form.id, 'revoked');
    const p = portal();
    const revoked = await p.post(`/f/${publicId}/sessions`, { invitationToken: TOKEN });
    expect(revoked.status).toBe(410);
    expect((await errorOf(revoked)).code).toBe('INVITATION_REVOKED');
    expect((await p.post(`/f/${publicId}/sessions`, { invitationToken: 'unknown-token-0123456789-abcdefghij' })).status).toBe(404);

    const other = await publish(simpleDefinition());
    await master.update(masterSchema.formInvitationRegistry).set({ revokedAt: null });
    expect((await p.post(`/f/${other.publicId}/sessions`, { invitationToken: TOKEN })).status).toBe(404);
  });
});
