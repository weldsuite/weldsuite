/**
 * Invitations, reminders, emails and notifications of WeldForms against pglite:
 * inviting members, CRM people, a CRM list and pasted addresses (skip reasons,
 * the outbound guard on the whole batch, the personal link), status and stats,
 * manual and automatic reminders (the due-index sweep), revoking, the receipt,
 * response notifications, the daily digest, the quota notices and members-only
 * uploads. Every route runs through the kit's test harness, so the same tests
 * can be replayed against the Rust backend; each sweep tick and ProcessResponse
 * run goes through `conformanceSweep` (jobs `forms-reminders`, `forms-digest`,
 * `forms-process-response`), which runs it on Rust too and compares the result,
 * events, mail and due index, and the assertions read Rust's rows and mail.
 *
 * The outbound guard is mocked on the TypeScript side; the tests that need it
 * to refuse (or a transport that fails) run on TypeScript only.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import type {
  CreateFormInvitationsResult,
  FormDetail,
  FormInvitation,
  FormInvitationStats,
  RemindFormInvitationsResult,
  StartSessionResult,
  SubmitSessionResult,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { runRemindersSweep, runDigestSweep } from './cron/sweeps';
import { sha256Hex } from './lib/crypto';
import fillRoutes from './routes/fill';
import formsRoutes from './routes/forms';
import invitationsRoutes from './routes/invitations';
import publicRoutes from './routes/public';
import { runProcessResponse, inlineSteps } from './workflows/process-response';
import { sendDueReminders } from './services/invitations';
import { workspaceCtx } from './services/context';
import { ORG, PORTAL_KEY, WS, eventNames, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, simpleDefinition, surveyDefinition, uploadDefinition, type World } from './test/support';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';

const mail = vi.hoisted(() => ({ transport: null as ReturnType<typeof memoryTransport> | null }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => mail.transport }));

/** The outbound guard: records what it was asked, and refuses on demand. */
const guard = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, refuse: false, commits: [] as unknown[] }));
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>();
  return {
    ...actual,
    checkOutbound: async (_env: unknown, _db: unknown, input: { to: string[] }) => {
      guard.calls.push(input as unknown as Record<string, unknown>);
      if (guard.refuse) throw new actual.OutboundDeniedError({ code: 'SENDING_SUSPENDED' });
      return { ledger: null, reservationId: 'res_1', sender: '', recipients: input.to, firstContact: [], mode: 'enforce' };
    },
    commitOutbound: async (_env: unknown, _db: unknown, _reservation: unknown, opts: unknown) => void guard.commits.push(opts),
    releaseOutbound: async () => undefined,
  };
});

// The conformance handles: in conformance mode the TypeScript run of a write
// gets the transaction it is rolled back in (the Rust run writes for real),
// and a sweep or ProcessResponse run on TypeScript gets a copy of the tenant (`dbs.tenant`).
const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(dbs.tenant),
    getWorkspaceForOrg: async () => ({ id: WS, clerkOrgId: ORG }),
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
  };
});

let db: Database;
let master: MasterDatabase;
let world: World;

const DUE_INDEX_SQL = readFileSync(resolve(__dirname, '../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  shareMasterDb(master);
}, 120_000);

beforeEach(async () => {
  world = newWorld({ SCHEDULE_INDEX: createSqliteD1(DUE_INDEX_SQL) });
  mail.transport = memoryTransport();
  guard.calls = [];
  guard.refuse = false;
  guard.commits = [];
  await resetForms(db, master);
  await db.delete(schema.notifications);
  await db.delete(schema.people);
  await db.delete(schema.listMembers);
  await db.delete(schema.lists);
  await seedWorkspace(master);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wmb_owner', userId: 'user_owner', email: 'owner@acme.test', name: 'Olivia Owner', role: 'OWNER' },
    { id: 'wmb_admin', userId: 'user_admin', email: 'admin@acme.test', name: 'Adam Admin', role: 'ADMIN' },
    { id: 'wmb_dan', userId: 'user_dan', email: 'dan@acme.test', name: 'Dan Member', role: 'MEMBER' },
    { id: 'wmb_noemail', userId: 'user_noemail', email: null, name: 'No Email', role: 'MEMBER' },
  ]);
});

const FORMS = '/api/forms/forms';
const PUBLIC = '/public/forms';
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const forms = (who?: Parameters<typeof memberApp>[4]) => memberApp(FORMS, formsRoutes, world, db, who);
const invites = (who?: Parameters<typeof memberApp>[4]) => memberApp(FORMS, invitationsRoutes, world, db, who);

async function publish(definition: FormDefinition = simpleDefinition(), settings: Record<string, unknown> = {}): Promise<{ form: FormDetail; publicId: string }> {
  const created = await data<FormDetail>(await forms().request(FORMS, json({ title: 'Customer feedback' })));
  const saved = await data<FormDetail>(await forms().request(`${FORMS}/${created.id}`, json({ revision: 1, definition, settings }, 'PATCH')));
  const { form } = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${saved.id}/publish`, json({})));
  world.sent.length = 0;
  return { form, publicId: form.publicId! };
}

const invite = (formId: string, body: Record<string, unknown>, who?: Parameters<typeof memberApp>[4]) => invites(who).request(`${FORMS}/${formId}/invitations`, json(body));
const sentMail = () => mail.transport!.sent;
/** The personal link in the last mail to `email`. */
const linkIn = (email: string) => {
  const m = [...sentMail()].reverse().find((s) => s.to[0]!.email === email)!;
  return /https:\/\/forms\.test\/i\/([A-Za-z0-9]+)\.([0-9a-f]+)/.exec(m.text)!;
};

function portal() {
  // The databases go in the context only for conformance mode, which serves them to the Rust server.
  const app = createTestApp(PUBLIC, publicRoutes, { env: world.env, context: { tenantDb: db, masterDb: master as unknown as Database, workspaceId: WS, orgId: ORG, clerkOrgId: ORG } });
  const headers = { 'X-Forms-Portal-Key': PORTAL_KEY, 'X-Respondent-Ip': '203.0.113.7', 'Content-Type': 'application/json' };
  return {
    start: (publicId: string, body: Record<string, unknown>) => app.request(`${PUBLIC}/f/${publicId}/sessions`, { method: 'POST', headers, body: JSON.stringify(body) }),
    submit: (session: string, answers: Record<string, unknown>) =>
      app.request(`${PUBLIC}/sessions/submit`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${session}` }, body: JSON.stringify({ answers }) }),
    sendCode: (publicId: string, email: string) => app.request(`${PUBLIC}/f/${publicId}/send-code`, { method: 'POST', headers, body: JSON.stringify({ email }) }),
  };
}

const rows = () => db.select().from(schema.formInvitations).orderBy(schema.formInvitations.email);

/** Runs on TypeScript only in conformance mode: the outbound guard (or the transport) is a TypeScript mock here. */
const itTypeScriptOnly = it.skipIf(Boolean(conformanceTarget()));

/**
 * The entity events a TypeScript run adds to `world.sent` (taken out, as the
 * hub queue carries them), and Rust's put back in their place, so the
 * assertions on `world.sent` read Rust's run.
 */
function eventHandles() {
  let from = world.sent.length;
  return {
    takeTypeScriptEvents: () => {
      const taken = world.sent.splice(from).map((m) => JSON.parse(JSON.stringify(m)) as Record<string, unknown>);
      from = world.sent.length;
      return taken;
    },
    onRustEvents: (events: Array<Record<string, unknown>>) =>
      void world.sent.push(
        ...events.map((e) => ({ ...e, eventType: `${String(e.entityType)}:${String(e.action)}`, metadata: { workspaceId: e.workspaceId, userId: e.userId } }) as never),
      ),
  };
}

/** One tick of a sweep, on Rust too in conformance mode (the test then reads Rust's result, rows, mail and events). */
async function sweep<R extends object>(job: 'forms-reminders' | 'forms-digest', kind: string, now: Date, run: () => Promise<R>): Promise<R> {
  await adoptRustDueTimes(kind);
  return conformanceSweep({
    job,
    now,
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: world.env as unknown as Record<string, unknown>,
    dueIndex: { d1: world.env.SCHEDULE_INDEX as never, kind },
    kv: world.env.WORKSPACE_CACHE as object,
    workspaces: { [WS]: ORG },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        return await run();
      } finally {
        dbs.tenant = db;
      }
    },
    ...eventHandles(),
  });
}

const remindersSweep = (now: Date) => sweep('forms-reminders', 'forms_reminders', now, () => runRemindersSweep(world.env, now));
const digestSweep = (now: Date) => sweep('forms-digest', 'forms_digest', now, () => runDigestSweep(world.env, now));

/**
 * In conformance mode a route's TypeScript run and Rust run each mark the
 * workspace due at their own `Date.now()`, milliseconds apart: the D1 index
 * takes Rust's time (what the rows the test reads were written with).
 */
async function adoptRustDueTimes(kind: string): Promise<void> {
  if (!conformanceTarget()) return;
  const result = (await master.execute(sql`select (extract(epoch from next_due_at) * 1000)::float8 as at from workspace_due_index where kind = ${kind} and workspace_id = ${WS}`)) as unknown as { rows: Array<{ at: number }> };
  const at = result.rows[0]?.at;
  if (at !== undefined) await world.env.SCHEDULE_INDEX!.prepare('UPDATE workspace_due_index SET next_due_at = ? WHERE kind = ? AND workspace_id = ?').bind(Math.round(Number(at)), kind, ORG).run();
}

/**
 * The harness clears the master due index the first time it sees a D1: let
 * that happen before the test's first row goes in (conformance mode only).
 */
async function primeDueIndex(kind: 'forms_reminders' | 'forms_digest'): Promise<void> {
  if (!conformanceTarget()) return;
  if (kind === 'forms_reminders') await remindersSweep(new Date(0));
  else await digestSweep(new Date(0));
}

/** A due row written by the test itself: in the D1 index and, for Rust, in the master one. */
async function insertDueRow(kind: string, at: number): Promise<void> {
  await world.env.SCHEDULE_INDEX!.prepare('INSERT INTO workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) VALUES (?, ?, ?, ?, 1)').bind(kind, ORG, at, Date.now()).run();
  if (conformanceTarget()) {
    await master.execute(sql`insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) values (${kind}, ${WS}, ${new Date(at).toISOString()}::timestamptz, now(), 1)`);
  }
}

describe('inviting', () => {
  it('invites pasted addresses with a personal link, an email each, events and registry rows', async () => {
    const { form, publicId } = await publish();
    const res = await invite(form.id, { recipients: { emails: [{ email: 'Ann@Example.com', name: 'Ann de Vries' }, { email: 'bob@example.com' }] } });
    expect(res.status).toBe(201);
    expect(await data<CreateFormInvitationsResult>(res)).toEqual({ created: 2, skipped: [] });

    expect(sentMail().map((m) => m.to[0]!.email).sort()).toEqual(['ann@example.com', 'bob@example.com']);
    const ann = sentMail().find((m) => m.to[0]!.email === 'ann@example.com')!;
    expect(ann.subject).toBe('Acme Staffing invited you to fill in "Customer feedback"');
    expect(ann.replyTo?.email).toBe('owner@acme.test');
    expect(ann.from.name).toContain('Acme Staffing');
    const [, pid, token] = linkIn('ann@example.com');
    expect(pid).toBe(publicId);
    expect(token).toHaveLength(64);

    const stored = await rows();
    expect(stored.map((r) => [r.email, r.name, r.status, r.locale, r.remindersSent, r.invitedByUserId])).toEqual([
      ['ann@example.com', 'Ann de Vries', 'sent', 'en', 0, 'user_owner'],
      ['bob@example.com', null, 'sent', 'en', 0, 'user_owner'],
    ]);
    expect(stored.every((r) => r.sentAt !== null)).toBe(true);
    const [reg] = await master.select().from(masterSchema.formInvitationRegistry).where(eq(masterSchema.formInvitationRegistry.invitationId, stored[0]!.id));
    expect(reg).toMatchObject({ tokenHash: await sha256Hex(token!), workspaceId: WS, clerkOrgId: ORG, formId: form.id, revokedAt: null });
    expect(eventNames(world.sent)).toEqual(['form_invitation:sent', 'form_invitation:sent']);
    expect(world.sent[0]!.data).toMatchObject({ formId: form.id, email: 'ann@example.com' });
    // Counted by the guard as one batch, from WeldSuite's address, source forms.
    expect(guard.calls).toHaveLength(1);
    expect(guard.calls[0]).toMatchObject({ source: 'forms', systemSender: true, to: ['ann@example.com', 'bob@example.com'] });
    expect(guard.commits).toHaveLength(1);
  });

  it('uses the sender subject and message and the chosen language', async () => {
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] }, subject: 'Two minutes of your time', message: 'Hi Ann,\nthanks!', locale: 'nl' });
    const m = sentMail()[0]!;
    expect(m.subject).toBe('Two minutes of your time');
    expect(m.text).toContain('Hi Ann,');
    expect(m.text).toContain('Open het formulier');
    const [row] = await rows();
    expect(row).toMatchObject({ locale: 'nl', subject: 'Two minutes of your time', message: 'Hi Ann,\nthanks!' });
  });

  it('resolves members, CRM people and a CRM list, and says why it skipped anyone', async () => {
    const { form } = await publish();
    await db.insert(schema.people).values([
      { id: 'per_ann', displayName: 'Ann Person', email: 'ann.person@example.com' },
      { id: 'per_nomail', displayName: 'No Mail', email: null },
      { id: 'per_bad', displayName: 'Bad Mail', email: 'not an email' },
      { id: 'per_list1', displayName: 'List One', email: 'list1@example.com' },
      { id: 'per_list2', displayName: 'List Two', email: 'list2@example.com' },
      { id: 'per_gone', displayName: 'Gone', email: 'gone@example.com', deletedAt: new Date() },
    ]);
    await db.insert(schema.lists).values({ id: 'lst_1', name: 'Customers', kind: 'person', type: 'static' });
    await db.insert(schema.listMembers).values([
      { id: 'lmb_1', listId: 'lst_1', entityId: 'per_list1' },
      { id: 'lmb_2', listId: 'lst_1', entityId: 'per_list2' },
      { id: 'lmb_3', listId: 'lst_1', entityId: 'per_gone' },
    ]);

    const res = await invite(form.id, {
      recipients: {
        emails: [{ email: 'paste@example.com' }, { email: 'PASTE@example.com' }],
        userIds: ['user_dan', 'user_noemail', 'user_unknown'],
        personIds: ['per_ann', 'per_nomail', 'per_unknown', 'per_bad'],
        listId: 'lst_1',
      },
    });
    const body = await data<CreateFormInvitationsResult>(res);
    expect(body.created).toBe(5);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { email: 'paste@example.com', reason: 'duplicate' },
        { email: 'not an email', reason: 'invalid' },
        { email: 'user_noemail', reason: 'no_email' },
        { email: 'user_unknown', reason: 'no_email' },
        { email: 'No Mail', reason: 'no_email' },
        { email: 'per_unknown', reason: 'no_email' },
      ]),
    );
    expect(body.skipped).toHaveLength(6);
    const stored = new Map((await rows()).map((r) => [r.email, r]));
    expect([...stored.keys()].sort()).toEqual(['ann.person@example.com', 'dan@acme.test', 'list1@example.com', 'list2@example.com', 'paste@example.com']);
    expect(stored.get('dan@acme.test')).toMatchObject({ userId: 'user_dan', name: 'Dan Member' });
    expect(stored.get('ann.person@example.com')).toMatchObject({ personId: 'per_ann', name: 'Ann Person' });
    expect(stored.get('list1@example.com')!.personId).toBe('per_list1');
  });

  it('skips people already invited or who already answered, and never invites twice', async () => {
    const { form } = await publish(simpleDefinition(), { onePerRespondent: true });
    await db.insert(schema.formResponses).values({ id: 'frs_done', formId: form.id, versionId: form.publishedVersion!.id, status: 'completed', number: 1, respondentEmail: 'done@example.com' });
    expect((await data<CreateFormInvitationsResult>(await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] } }))).created).toBe(1);
    const again = await data<CreateFormInvitationsResult>(await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'done@example.com' }, { email: 'new@example.com' }] } }));
    expect(again).toEqual({ created: 1, skipped: [{ email: 'ann@example.com', reason: 'duplicate' }, { email: 'done@example.com', reason: 'already_responded' }] });
    await db.update(schema.formInvitations).set({ status: 'completed', completedAt: new Date() }).where(eq(schema.formInvitations.email, 'ann@example.com'));
    const third = await data<CreateFormInvitationsResult>(await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] } }));
    expect(third).toEqual({ created: 0, skipped: [{ email: 'ann@example.com', reason: 'already_responded' }] });
  });

  itTypeScriptOnly('is refused by the outbound guard as a whole: nothing is sent or written', async () => {
    const { form } = await publish();
    guard.refuse = true;
    const res = await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }] } });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('EMAIL_REFUSED');
    expect(sentMail()).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(await master.select().from(masterSchema.formInvitationRegistry)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
    expect(OutboundDeniedError).toBeDefined();
  });

  itTypeScriptOnly('drops an invitation whose mail could not be sent', async () => {
    const { form } = await publish();
    const real = mail.transport!;
    const flaky = { ...real, send: async (email: Parameters<typeof real.send>[0]) => (email.to[0]!.email === 'bad@example.com' ? Promise.reject(new Error('rejected')) : real.send(email)) };
    mail.transport = flaky as unknown as typeof mail.transport;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await data<CreateFormInvitationsResult>(await invite(form.id, { recipients: { emails: [{ email: 'ok@example.com' }, { email: 'bad@example.com' }] } }));
    error.mockRestore();
    expect(body).toEqual({ created: 1, skipped: [{ email: 'bad@example.com', reason: 'invalid' }] });
    expect((await rows()).map((r) => r.email)).toEqual(['ok@example.com']);
    expect(await master.select().from(masterSchema.formInvitationRegistry)).toHaveLength(1);
    expect(guard.commits).toEqual([{ sentRecipients: ['ok@example.com'] }]);
  });

  it('needs a published, open form with quota left, and a sensible batch', async () => {
    const draft = await data<FormDetail>(await forms().request(FORMS, json({ title: 'Draft' })));
    expect((await invite(draft.id, { recipients: { emails: [{ email: 'a@example.com' }] } })).status).toBe(409);

    const { form } = await publish(simpleDefinition(), { closesAt: new Date(Date.now() - 1000).toISOString() });
    const closed = await invite(form.id, { recipients: { emails: [{ email: 'a@example.com' }] } });
    expect([closed.status, (await errorOf(closed)).code]).toEqual([409, 'FORM_CLOSED']);

    const live = await publish();
    const many = Array.from({ length: 501 }, (_, i) => ({ email: `p${i}@example.com` }));
    // The schema caps one list at 500; a CRM list can still push the batch over.
    expect((await invite(live.form.id, { recipients: { emails: many } })).status).toBe(400);
    await db.insert(schema.lists).values({ id: 'lst_big', name: 'Big', kind: 'person', type: 'static' });
    const people = Array.from({ length: 501 }, (_, i) => ({ id: `per_b${i}`, displayName: `B${i}`, email: `b${i}@example.com` }));
    for (let i = 0; i < people.length; i += 100) await db.insert(schema.people).values(people.slice(i, i + 100));
    await db.insert(schema.listMembers).values(people.map((p, i) => ({ id: `lmb_b${i}`, listId: 'lst_big', entityId: p.id })));
    const tooMany = await invite(live.form.id, { recipients: { listId: 'lst_big' } });
    expect([tooMany.status, (await errorOf(tooMany)).code]).toEqual([422, 'TOO_MANY_RECIPIENTS']);

    // A workspace over its monthly quota cannot take the answers: no point inviting.
    const now = new Date();
    await db.insert(schema.formResponses).values(Array.from({ length: 100 }, (_, i) => ({ id: `frs_q${i}`, formId: live.form.id, versionId: live.form.publishedVersion!.id, status: 'completed' as const, number: i + 1, submittedAt: now })));
    const over = await invite(live.form.id, { recipients: { emails: [{ email: 'a@example.com' }] } });
    expect([over.status, (await errorOf(over)).code]).toEqual([409, 'OVER_QUOTA']);
    expect(sentMail()).toHaveLength(0);
  });

  it('is gated by forms:send and by access to the form', async () => {
    const { form } = await publish();
    const body = { recipients: { emails: [{ email: 'a@example.com' }] } };
    expect((await invite(form.id, body, { permissions: ['forms:read'] })).status).toBe(403);
    expect((await invites({ permissions: ['forms:read'] }).request(`${FORMS}/${form.id}/invitations`)).status).toBe(403);
    await forms().request(`${FORMS}/${form.id}`, json({ revision: form.revision, access: 'restricted' }, 'PATCH'));
    expect((await invite(form.id, body, { userId: 'user_other', permissions: ['forms:read', 'forms:send'] })).status).toBe(404);
  });
});

describe('status, list and stats', () => {
  it('follows a person through opened, started and completed and counts them', async () => {
    const { form, publicId } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }, { email: 'cy@example.com' }, { email: 'dee@example.com' }] } });
    const p = portal();

    const ann = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] }));
    expect(ann.respondentEmail).toBe('ann@example.com');
    const bob = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('bob@example.com')[2] }));
    const submitted = await p.submit(ann.session, { b_name: 'Ann' });
    expect(submitted.status).toBe(200);
    void bob;
    await db.update(schema.formInvitations).set({ status: 'started', startedAt: new Date() }).where(eq(schema.formInvitations.email, 'cy@example.com'));

    const stats = await data<FormInvitationStats>(await invites().request(`${FORMS}/${form.id}/invitations/stats`));
    expect(stats).toEqual({ total: 4, sent: 1, opened: 1, started: 1, completed: 1, revoked: 0 });

    const list = (await (await invites().request(`${FORMS}/${form.id}/invitations?status=completed`)).json()) as { data: FormInvitation[]; pagination: { totalCount: number } };
    expect(list.pagination.totalCount).toBe(1);
    expect(list.data[0]).toMatchObject({ email: 'ann@example.com', status: 'completed', responseId: ann.responseId });
    expect(list.data[0]!.completedAt).not.toBeNull();
    const opened = (await (await invites().request(`${FORMS}/${form.id}/invitations?status=opened`)).json()) as { data: FormInvitation[] };
    expect(opened.data.map((i) => i.email)).toEqual(['bob@example.com']);
    expect(opened.data[0]!.openedAt).not.toBeNull();

    const found = (await (await invites().request(`${FORMS}/${form.id}/invitations?q=DEE`)).json()) as { data: FormInvitation[] };
    expect(found.data.map((i) => i.email)).toEqual(['dee@example.com']);
    const first = (await (await invites().request(`${FORMS}/${form.id}/invitations?limit=3`)).json()) as { data: FormInvitation[]; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data).toHaveLength(3);
    expect(first.pagination.hasMore).toBe(true);
    const rest = (await (await invites().request(`${FORMS}/${form.id}/invitations?limit=3&cursor=${first.pagination.cursor}`)).json()) as { data: FormInvitation[] };
    expect(rest.data).toHaveLength(1);

    // The completed event comes from the submit; the response is the invitee's.
    expect(eventNames(world.sent)).toEqual(expect.arrayContaining(['form_response:submitted', 'form_invitation:completed']));
    const [response] = await db.select().from(schema.formResponses).where(eq(schema.formResponses.id, ann.responseId));
    expect(response).toMatchObject({ status: 'completed', invitationId: expect.any(String), respondentEmail: 'ann@example.com' });
  });

  it('links the response of an invited CRM person to them', async () => {
    const { form, publicId } = await publish();
    await db.insert(schema.people).values({ id: 'per_ann', displayName: 'Ann', email: 'ann@example.com' });
    await invite(form.id, { recipients: { personIds: ['per_ann'] } });
    const p = portal();
    const session = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] }));
    await p.submit(session.session, { b_name: 'Ann' });
    const [response] = await db.select().from(schema.formResponses).where(eq(schema.formResponses.id, session.responseId));
    expect(response!.personId).toBe('per_ann');
    expect(world.sent.find((m) => m.eventType === 'form_response:submitted')!.data).toMatchObject({ personId: 'per_ann' });
  });
});

describe('revoking', () => {
  it('stops every link of the invitation and publishes form_invitation:revoked', async () => {
    const { form, publicId } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }] } });
    const [annRow] = await db.select().from(schema.formInvitations).where(eq(schema.formInvitations.email, 'ann@example.com'));
    world.sent.length = 0;

    const res = await invites().request(`${FORMS}/${form.id}/invitations/${annRow!.id}/revoke`, json({}));
    expect(res.status).toBe(200);
    const revoked = await data<FormInvitation>(res);
    expect(revoked).toMatchObject({ id: annRow!.id, status: 'revoked', nextReminderAt: null });
    expect(revoked.revokedAt).not.toBeNull();
    expect(eventNames(world.sent)).toEqual(['form_invitation:revoked']);
    const [reg] = await master.select().from(masterSchema.formInvitationRegistry).where(eq(masterSchema.formInvitationRegistry.invitationId, annRow!.id));
    expect(reg!.revokedAt).not.toBeNull();

    const p = portal();
    const gone = await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] });
    expect([gone.status, (await errorOf(gone)).code]).toEqual([410, 'INVITATION_REVOKED']);
    expect((await p.start(publicId, { invitationToken: linkIn('bob@example.com')[2] })).status).toBe(201);
    expect((await data<FormInvitationStats>(await invites().request(`${FORMS}/${form.id}/invitations/stats`))).revoked).toBe(1);
    // Revoking again is harmless; an unknown invitation is a 404.
    expect((await invites().request(`${FORMS}/${form.id}/invitations/${annRow!.id}/revoke`, json({}))).status).toBe(200);
    expect((await invites().request(`${FORMS}/${form.id}/invitations/fin_none/revoke`, json({}))).status).toBe(404);
  });

  it('refuses to revoke an invitation that was completed', async () => {
    const { form, publicId } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] } });
    const p = portal();
    const session = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] }));
    await p.submit(session.session, { b_name: 'Ann' });
    const [row] = await rows();
    const res = await invites().request(`${FORMS}/${form.id}/invitations/${row!.id}/revoke`, json({}));
    expect([res.status, (await errorOf(res)).code]).toEqual([409, 'ALREADY_COMPLETED']);
  });
});

describe('reminders by hand', () => {
  const HOUR = 60 * 60 * 1000;
  const remind = (formId: string, body: Record<string, unknown> = {}) => invites().request(`${FORMS}/${formId}/invitations/remind`, json(body));
  const age = (hours: number) => db.update(schema.formInvitations).set({ sentAt: new Date(Date.now() - hours * HOUR), lastRemindedAt: null });

  it('reminds everyone who has not answered with a fresh link, skipping anyone emailed in the last hour', async () => {
    const { form, publicId } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }, { email: 'cy@example.com' }] } });
    const p = portal();
    const ann = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] }));
    await p.submit(ann.session, { b_name: 'Ann' });

    // Just invited: nobody is due yet.
    expect(await data<RemindFormInvitationsResult>(await remind(form.id))).toEqual({ reminded: 0, skipped: 2 });
    expect(sentMail()).toHaveLength(3);

    await age(2);
    const firstToken = linkIn('bob@example.com')[2];
    world.sent.length = 0;
    expect(await data<RemindFormInvitationsResult>(await remind(form.id))).toEqual({ reminded: 2, skipped: 0 });
    const mails = sentMail().slice(3);
    expect(mails.map((m) => m.to[0]!.email).sort()).toEqual(['bob@example.com', 'cy@example.com']);
    expect(mails[0]!.subject).toBe('Reminder: "Customer feedback"');
    expect(linkIn('bob@example.com')[2]).not.toBe(firstToken);
    expect(eventNames(world.sent)).toEqual(['form_invitation:sent', 'form_invitation:sent']);
    expect(world.sent[0]!.data).toMatchObject({ reminder: true });
    const bob = (await rows()).find((r) => r.email === 'bob@example.com')!;
    expect(bob).toMatchObject({ remindersSent: 1, status: 'sent' });
    expect(bob.lastRemindedAt).not.toBeNull();

    // Both the old and the new link open the form.
    expect((await p.start(publicId, { invitationToken: firstToken })).status).toBe(201);
    expect((await p.start(publicId, { invitationToken: linkIn('bob@example.com')[2] })).status).toBe(201);

    // Within the hour again: skipped.
    expect(await data<RemindFormInvitationsResult>(await remind(form.id))).toEqual({ reminded: 0, skipped: 2 });
  });

  it('reminds only the given invitations, and not the completed or revoked ones', async () => {
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }, { email: 'cy@example.com' }] } });
    await age(3);
    await db.update(schema.formInvitations).set({ status: 'completed' }).where(eq(schema.formInvitations.email, 'ann@example.com'));
    await db.update(schema.formInvitations).set({ status: 'revoked' }).where(eq(schema.formInvitations.email, 'bob@example.com'));
    const all = await rows();
    const ids = all.map((r) => r.id);
    expect(await data<RemindFormInvitationsResult>(await remind(form.id, { invitationIds: ids }))).toEqual({ reminded: 1, skipped: 0 });
    expect(sentMail().slice(3).map((m) => m.to[0]!.email)).toEqual(['cy@example.com']);
  });

  itTypeScriptOnly('is stopped by the guard and by a form that is closed', async () => {
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] } });
    await age(3);
    guard.refuse = true;
    const refused = await remind(form.id);
    expect([refused.status, (await errorOf(refused)).code]).toEqual([422, 'EMAIL_REFUSED']);
    expect(sentMail()).toHaveLength(1);
    guard.refuse = false;
    await forms().request(`${FORMS}/${form.id}/close`, json({}));
    expect((await remind(form.id)).status).toBe(409);
    expect(sentMail()).toHaveLength(1);
  });
});

describe('automatic reminders', () => {
  const DAY = 24 * 60 * 60 * 1000;
  beforeEach(() => primeDueIndex('forms_reminders'));
  const dueRow = (kind: string) => world.env.SCHEDULE_INDEX!.prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?').bind(kind, ORG).first<number>('next_due_at');

  it('plans the first reminder, marks the workspace due, and the sweep sends the reminders on schedule, at most maxCount', async () => {
    const { form } = await publish();
    const before = Date.now();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }] }, reminders: { afterDays: 3, everyDays: 2, maxCount: 2 } });
    const [ann] = (await rows()).filter((r) => r.email === 'ann@example.com');
    const first = ann!.nextReminderAt!.getTime();
    expect(first).toBeGreaterThanOrEqual(before + 3 * DAY);
    expect(first).toBeLessThan(Date.now() + 3 * DAY + 1000);
    await adoptRustDueTimes('forms_reminders');
    expect(await dueRow('forms_reminders')).toBe(first);

    // Not yet due: the sweep reads only D1 and opens nothing.
    const quiet = await remindersSweep(new Date(first - 1000));
    expect(quiet).toMatchObject({ due: 0, reminded: 0 });

    // Due: both are reminded, the second reminder is two days later.
    world.sent.length = 0;
    const swept = await remindersSweep(new Date(first + 1000));
    expect(swept).toMatchObject({ due: 1, processed: 1, reminded: 2 });
    expect(sentMail().slice(2).map((m) => m.subject)).toEqual(['Reminder: "Customer feedback"', 'Reminder: "Customer feedback"']);
    expect(eventNames(world.sent)).toEqual(['form_invitation:sent', 'form_invitation:sent']);
    const afterFirst = await rows();
    expect(afterFirst.map((r) => r.remindersSent)).toEqual([1, 1]);
    const second = afterFirst[0]!.nextReminderAt!.getTime();
    expect(second).toBe(first + 1000 + 2 * DAY);
    expect(await dueRow('forms_reminders')).toBe(second);

    // The second and last one: nothing is planned afterwards and the index row is dropped.
    await remindersSweep(new Date(second + 1000));
    const done = await rows();
    expect(done.map((r) => [r.remindersSent, r.nextReminderAt])).toEqual([[2, null], [2, null]]);
    expect(await dueRow('forms_reminders')).toBeNull();
    expect(sentMail()).toHaveLength(6);
  });

  it('follows the workspace defaults when the invitation says nothing, and none with reminders: null', async () => {
    await db.insert(schema.formSettings).values({ id: 'fst_1', reminderAfterDays: 4, reminderEveryDays: 1, reminderMaxCount: 3 });
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] } });
    await invite(form.id, { recipients: { emails: [{ email: 'bob@example.com' }] }, reminders: null });
    const [ann, bob] = await rows();
    expect(bob!.nextReminderAt).toBeNull();
    expect(Math.round((ann!.nextReminderAt!.getTime() - ann!.sentAt!.getTime()) / DAY)).toBe(4);
  });

  it('never reminds after the close date or the form being closed, and never someone who completed', async () => {
    const { form, publicId } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }, { email: 'cy@example.com' }] }, reminders: { afterDays: 1, everyDays: 1, maxCount: 3 } });
    const p = portal();
    const ann = await data<StartSessionResult>(await p.start(publicId, { invitationToken: linkIn('ann@example.com')[2] }));
    await p.submit(ann.session, { b_name: 'Ann' });
    const later = new Date(Date.now() + 2 * DAY);

    // Closed by hand: the sweep drops the plan instead of sending.
    await forms().request(`${FORMS}/${form.id}/close`, json({}));
    const swept = await remindersSweep(later);
    expect(swept).toMatchObject({ due: 1, processed: 1, reminded: 0 });
    expect(sentMail()).toHaveLength(3);
    expect((await rows()).every((r) => r.nextReminderAt === null)).toBe(true);

    // Reopened with a close date in the past: still nothing.
    await forms().request(`${FORMS}/${form.id}/reopen`, json({}));
    await db.update(schema.formInvitations).set({ nextReminderAt: new Date(Date.now() - DAY), sentAt: new Date(Date.now() - 3 * DAY) });
    const [formRow] = await db.select().from(schema.forms).where(eq(schema.forms.id, form.id));
    await db.update(schema.forms).set({ settings: { ...formRow!.settings, closesAt: new Date(Date.now() - 1000).toISOString() } }).where(eq(schema.forms.id, form.id));
    const ctx = workspaceCtx({ env: world.env, get: (k: string) => ({ tenantDb: db, workspaceId: WS, clerkOrgId: ORG })[k] } as never);
    const result = await sendDueReminders(ctx, new Date());
    expect(result.reminded).toEqual([]);
    expect(sentMail()).toHaveLength(3);
  });

  itTypeScriptOnly('backs off a day-part when the guard refuses, instead of asking it every tick', async () => {
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }] }, reminders: { afterDays: 1, everyDays: 1, maxCount: 3 } });
    const [row] = await rows();
    guard.refuse = true;
    const at = new Date(row!.nextReminderAt!.getTime() + 1000);
    const swept = await remindersSweep(at);
    expect(swept).toMatchObject({ processed: 1, reminded: 0 });
    const [after] = await rows();
    expect(after).toMatchObject({ remindersSent: 0 });
    expect(after!.nextReminderAt!.getTime()).toBe(at.getTime() + 6 * 60 * 60 * 1000);
    expect(sentMail()).toHaveLength(1);
  });

  itTypeScriptOnly('tries a reminder whose mail did not go out again later, and keeps no link for it', async () => {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const { form } = await publish();
    await invite(form.id, { recipients: { emails: [{ email: 'ann@example.com' }, { email: 'bob@example.com' }] }, reminders: { afterDays: 1, everyDays: 2, maxCount: 3 } });
    const invited = await rows();
    const links = async (email: string) =>
      (await master.select().from(masterSchema.formInvitationRegistry).where(eq(masterSchema.formInvitationRegistry.invitationId, invited.find((r) => r.email === email)!.id))).length;
    const real = mail.transport!;
    const flaky = { ...real, send: async (email: Parameters<typeof real.send>[0]) => (email.to[0]!.email === 'bob@example.com' ? Promise.reject(new Error('rejected')) : real.send(email)) };
    mail.transport = flaky as unknown as typeof mail.transport;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const at = new Date(invited[0]!.nextReminderAt!.getTime() + 1000);
      expect(await remindersSweep(at)).toMatchObject({ processed: 1, reminded: 1 });
      const [ann, bob] = await rows();
      expect(ann!.remindersSent).toBe(1);
      expect(ann!.nextReminderAt!.getTime()).toBe(at.getTime() + 2 * DAY);
      expect(bob!.remindersSent).toBe(0);
      expect(bob!.nextReminderAt!.getTime()).toBe(at.getTime() + SIX_HOURS);
      expect([await links('ann@example.com'), await links('bob@example.com')]).toEqual([2, 1]);

      // Not picked up again on the next tick, and no transport at all adds no link either.
      await remindersSweep(new Date(at.getTime() + 15 * 60 * 1000));
      mail.transport = null;
      const later = new Date(at.getTime() + SIX_HOURS + 1000);
      await remindersSweep(later);
      expect(await links('bob@example.com')).toBe(1);
      const [, retried] = await rows();
      expect(retried!.remindersSent).toBe(0);
      expect(retried!.nextReminderAt!.getTime()).toBe(later.getTime() + SIX_HOURS);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('the code email', () => {
  itTypeScriptOnly('goes through the outbound guard (source forms) and is refused without sending a code', async () => {
    const { publicId } = await publish(simpleDefinition(), { respondentMode: 'verified_email' });
    const p = portal();
    const ok = await p.sendCode(publicId, 'ann@example.com');
    expect(ok.status).toBe(200);
    expect(sentMail()).toHaveLength(1);
    expect(guard.calls[0]).toMatchObject({ source: 'forms', systemSender: true, to: ['ann@example.com'] });
    expect(guard.commits).toHaveLength(1);

    guard.refuse = true;
    const refused = await p.sendCode(publicId, 'bob@example.com');
    expect([refused.status, (await errorOf(refused)).code]).toEqual([503, 'EMAIL_UNAVAILABLE']);
    expect(sentMail()).toHaveLength(1);
  });
});

// ── Notifications and emails after a response ────────────────────────────────

/** A completed response straight into the tenant DB, then ProcessResponse over it. */
let respondSeq = 0;
async function respond(form: FormDetail, over: Partial<typeof schema.formResponses.$inferInsert> = {}, definition?: FormDefinition): Promise<string> {
  const [{ n }] = (await db.select().from(schema.forms).where(eq(schema.forms.id, form.id))).map((f) => ({ n: f.responseCounter + 1 }));
  const id = over.id ?? `frs_n${++respondSeq}`;
  await db.update(schema.forms).set({ responseCounter: n, responseCount: n }).where(eq(schema.forms.id, form.id));
  await db.insert(schema.formResponses).values({
    id,
    formId: form.id,
    versionId: form.publishedVersion!.id,
    status: 'completed',
    number: n,
    answers: { b_name: 'Ann' },
    submittedAt: new Date(),
    ...over,
  });
  void definition;
  return id;
}

/** One ProcessResponse run with every step, on Rust too in conformance mode (the test then reads Rust's rows, mail and events). */
const process = async (formId: string, responseId: string, mode: 'submit' | 'update' = 'submit') => {
  const params = { clerkOrgId: ORG, workspaceId: WS, formId, responseId, mode };
  await conformanceSweep({
    job: 'forms-process-response',
    now: new Date(),
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: world.env as unknown as Record<string, unknown>,
    dueIndex: { d1: world.env.SCHEDULE_INDEX as never, kind: 'forms_digest' },
    kv: world.env.WORKSPACE_CACHE as object,
    workspaces: { [WS]: ORG },
    input: { params },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        await runProcessResponse(world.env, params, inlineSteps);
        return {};
      } finally {
        dbs.tenant = db;
      }
    },
    ...eventHandles(),
  });
};

describe('response notifications', () => {
  const notificationsOf = (userId: string) => db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));

  it('notifies instant subscribers on the platform, not the others, and marks the digest due for daily ones', async () => {
    const { form } = await publish();
    await db.insert(schema.formSubscriptions).values([
      { id: 'fsb_i', formId: form.id, userId: 'user_dan', mode: 'instant' },
      { id: 'fsb_d', formId: form.id, userId: 'user_admin', mode: 'daily' },
      { id: 'fsb_o', formId: form.id, userId: 'user_noemail', mode: 'off' },
    ]);
    const id = await respond(form, { respondentEmail: 'ann@example.com' });
    await process(form.id, id);

    const owner = await notificationsOf('user_owner');
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ category: 'weldforms', notificationType: 'form_response', entityType: 'form_response', entityId: id, title: 'New response to "Customer feedback"', body: 'From ann@example.com' });
    expect(owner[0]!.actionUrl).toBe(`/weldforms/${form.id}/results?tab=responses&response=${id}`);
    expect(await notificationsOf('user_dan')).toHaveLength(1);
    expect(await notificationsOf('user_admin')).toHaveLength(0);
    expect(await notificationsOf('user_noemail')).toHaveLength(0);

    // The instant mail carries the answers; the daily subscriber's digest is due at 08:00 UTC.
    const instant = sentMail().filter((m) => m.subject === 'New response to "Customer feedback"');
    expect(instant.map((m) => m.to[0]!.email).sort()).toEqual(['dan@acme.test', 'owner@acme.test']);
    expect(instant[0]!.text).toContain('Ann');
    const due = await world.env.SCHEDULE_INDEX!.prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ?').bind('forms_digest').first<number>('next_due_at');
    expect(new Date(due!).getUTCHours()).toBe(8);
    expect(due!).toBeGreaterThan(Date.now());
  });

  it('sends only a link, no answers, when the form has sensitive fields, and nothing for an edit', async () => {
    const { form } = await publish(surveyDefinition());
    const id = await respond(form, { answers: { b_name: 'Ann', b_note: 'very private', b_plan: { choiceIds: ['c_pro'] } } });
    await process(form.id, id);
    const m = sentMail().find((s) => s.to[0]!.email === 'owner@acme.test')!;
    expect(m.text).not.toContain('very private');
    expect(m.text).not.toContain('Ann');
    expect(m.text).toContain('private fields');
    expect(m.text).toContain(`weldforms/${form.id}/results`);

    sentMail().length = 0;
    await db.delete(schema.notifications);
    await process(form.id, id, 'update');
    expect(sentMail()).toHaveLength(0);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
  });
});

describe('the daily digest', () => {
  beforeEach(() => primeDueIndex('forms_digest'));
  it('sends each daily subscriber the responses since their last digest, once, from the sweep at 08:00', async () => {
    const { form } = await publish();
    await db.insert(schema.formSubscriptions).values({ id: 'fsb_d', formId: form.id, userId: 'user_admin', mode: 'daily', lastDigestAt: new Date(Date.UTC(2026, 10, 9, 0)) });
    for (let i = 0; i < 12; i++) await respond(form, { answers: { b_name: `Person ${i}` }, respondentEmail: i % 2 ? `p${i}@example.com` : null, submittedAt: new Date(Date.UTC(2026, 10, 9, 1 + i)) });
    // The sweep's due time is set by the notify step; set it directly here.
    await insertDueRow('forms_digest', Date.UTC(2026, 10, 10, 8));
    sentMail().length = 0;

    const early = await digestSweep(new Date(Date.UTC(2026, 10, 10, 7, 45)));
    expect(early).toMatchObject({ due: 0, sent: 0 });
    const swept = await digestSweep(new Date(Date.UTC(2026, 10, 10, 8, 0, 30)));
    expect(swept).toMatchObject({ due: 1, processed: 1, sent: 1 });
    expect(sentMail()).toHaveLength(1);
    const digest = sentMail()[0]!;
    expect(digest.to[0]!.email).toBe('admin@acme.test');
    expect(digest.subject).toBe('12 new responses to "Customer feedback"');
    expect(digest.text).toContain('Person 11');
    expect(digest.text).toContain('And 2 more.');
    const [sub] = await db.select().from(schema.formSubscriptions).where(eq(schema.formSubscriptions.id, 'fsb_d'));
    expect(sub!.lastDigestAt!.toISOString()).toBe('2026-11-10T08:00:30.000Z');

    // Nothing new: nothing sent, and the index row is gone until the next response.
    await world.env.SCHEDULE_INDEX!.prepare('UPDATE workspace_due_index SET next_due_at = ?').bind(Date.UTC(2026, 10, 11, 8)).run();
    if (conformanceTarget()) await master.execute(sql`update workspace_due_index set next_due_at = ${new Date(Date.UTC(2026, 10, 11, 8)).toISOString()}::timestamptz where kind = 'forms_digest'`);
    await digestSweep(new Date(Date.UTC(2026, 10, 11, 8, 1)));
    expect(sentMail()).toHaveLength(1);
    expect(await world.env.SCHEDULE_INDEX!.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n')).toBe(0);
  });

  it('names who answered but not what, when the form has sensitive fields', async () => {
    const { form } = await publish(surveyDefinition());
    await db.insert(schema.formSubscriptions).values({ id: 'fsb_d', formId: form.id, userId: 'user_admin', mode: 'daily' });
    await respond(form, { answers: { b_name: 'Ann', b_note: 'very private' }, respondentEmail: 'ann@example.com', submittedAt: new Date(Date.UTC(2026, 10, 9, 20)) });
    await insertDueRow('forms_digest', Date.UTC(2026, 10, 10, 8));
    await digestSweep(new Date(Date.UTC(2026, 10, 10, 8, 5)));
    const digest = sentMail().find((m) => m.to[0]!.email === 'admin@acme.test')!;
    expect(digest.text).toContain('ann@example.com');
    expect(digest.text).not.toContain('very private');
  });
});

describe('the receipt', () => {
  const receipts = () => sentMail().filter((m) => m.subject.startsWith('Your answers to'));

  it('is a copy of the answers to a verified address, without sensitive fields, files and signatures', async () => {
    const { form } = await publish(surveyDefinition(), { respondentMode: 'verified_email', sendReceipt: true });
    const id = await respond(form, { respondentEmail: 'ann@example.com', answers: { b_name: 'Ann', b_note: 'very private', b_plan: { choiceIds: ['c_pro'] } } });
    await process(form.id, id);
    expect(receipts()).toHaveLength(1);
    const m = receipts()[0]!;
    expect(m.to[0]!.email).toBe('ann@example.com');
    expect(m.text).toContain('Your name: Ann');
    expect(m.text).toContain('Which plan?: Pro');
    expect(m.text).not.toContain('very private');
    expect(m.from.name).toContain('Acme Staffing');
    // An edit does not send another copy.
    await process(form.id, id, 'update');
    expect(receipts()).toHaveLength(1);
  });

  it('goes to an invited address on an open form, never to one typed into an anonymous form', async () => {
    const { form } = await publish(simpleDefinition(), { sendReceipt: true });
    const typed = await respond(form, { respondentEmail: 'stranger@example.com' });
    await process(form.id, typed);
    expect(receipts()).toHaveLength(0);

    await db.insert(schema.formInvitations).values({ id: 'fin_1', formId: form.id, email: 'ann@example.com', invitedByUserId: 'user_owner' });
    const invited = await respond(form, { respondentEmail: 'ann@example.com', invitationId: 'fin_1' });
    await process(form.id, invited);
    expect(receipts().map((m) => m.to[0]!.email)).toEqual(['ann@example.com']);
  });

  it('is off unless the form asks for it, and never for members-only forms', async () => {
    const off = await publish(simpleDefinition(), { respondentMode: 'verified_email' });
    await process(off.form.id, await respond(off.form, { respondentEmail: 'ann@example.com' }));
    const members = await publish(simpleDefinition(), { respondentMode: 'members', sendReceipt: true });
    await process(members.form.id, await respond(members.form, { respondentEmail: 'dan@acme.test' }));
    expect(receipts()).toHaveLength(0);
  });
});

describe('quota notices', () => {
  const quotaMails = () => sentMail().filter((m) => m.subject.includes('monthly form response'));

  it('tells the admins at 80 % and at 100 %, once per threshold per month', async () => {
    const { form } = await publish();
    const now = new Date();
    const fill = async (count: number) => {
      const [{ n }] = await db.select({ n: schema.forms.responseCounter }).from(schema.forms).where(eq(schema.forms.id, form.id)).then((r) => r.map((x) => ({ n: x.n })));
      await db.insert(schema.formResponses).values(Array.from({ length: count }, (_, i) => ({ id: `frs_q${n}_${i}`, formId: form.id, versionId: form.publishedVersion!.id, status: 'completed' as const, number: n + i + 1, submittedAt: now })));
      await db.update(schema.forms).set({ responseCounter: n + count }).where(eq(schema.forms.id, form.id));
    };
    await fill(79);
    await process(form.id, 'frs_q0_0');
    expect(quotaMails()).toHaveLength(0);

    await fill(1);
    await process(form.id, 'frs_q0_0');
    expect(quotaMails().map((m) => m.to[0]!.email).sort()).toEqual(['admin@acme.test', 'owner@acme.test']);
    expect(quotaMails()[0]!.subject).toBe('Acme Staffing has used 80% of its monthly form responses');
    expect(quotaMails()[0]!.text).toContain('80 of 100');

    // The same threshold is not sent twice.
    await process(form.id, 'frs_q0_0');
    expect(quotaMails()).toHaveLength(2);

    await fill(20);
    await process(form.id, 'frs_q0_0');
    expect(quotaMails()).toHaveLength(4);
    expect(quotaMails()[2]!.subject).toBe('Acme Staffing reached its monthly form response limit');
    await process(form.id, 'frs_q0_0');
    expect(quotaMails()).toHaveLength(4);
  });
});

// ── Members-only uploads ─────────────────────────────────────────────────────

describe('uploads on a members-only form', () => {
  const FILL = '/api/forms/fill';
  const fill = (who?: Parameters<typeof memberApp>[4]) => memberApp(FILL, fillRoutes, world, db, who);
  const upload = (publicId: string, blockId: string, file: File, who?: Parameters<typeof memberApp>[4]) => {
    const body = new FormData();
    body.append('blockId', blockId);
    body.append('file', file);
    return fill(who).request(`${FILL}/${publicId}/uploads`, { method: 'POST', body });
  };
  const pdf = (name = 'cv.pdf') => new File([new Uint8Array([37, 80, 68, 70, 45])], name, { type: 'application/pdf' });

  it('keeps the file with the member\'s unfinished response, which the submit then completes', async () => {
    const { form, publicId } = await publish(uploadDefinition(), { respondentMode: 'members' });
    const first = await upload(publicId, 'b_cv', pdf('one.pdf'));
    expect(first.status).toBe(201);
    const one = (await data<{ file: { fileId: string; name: string; size: number; type: string } }>(first)).file;
    expect(one).toMatchObject({ name: 'one.pdf', size: 5, type: 'application/pdf' });
    const two = (await data<{ file: { fileId: string } }>(await upload(publicId, 'b_cv', pdf('two.pdf')))).file;

    // One unfinished response of the member holds both.
    const open = await db.select().from(schema.formResponses);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: 'in_progress', formId: form.id, respondentUserId: 'user_owner', metadata: { source: 'members' } });
    const files = await db.select().from(schema.formResponseFiles);
    expect(files.map((f) => [f.responseId, f.blockId, f.name]).sort()).toEqual([[open[0]!.id, 'b_cv', 'one.pdf'], [open[0]!.id, 'b_cv', 'two.pdf']]);
    expect(files[0]!.storageKey.startsWith(`weldforms/pending/${open[0]!.id}/`)).toBe(true);

    const res = await fill().request(`${FILL}/${publicId}`, json({ answers: { b_name: 'Ann', b_cv: [one, two] } }));
    expect(res.status).toBe(201);
    const result = await data<SubmitSessionResult>(res);
    expect(result.responseId).toBe(open[0]!.id);
    const done = await db.select().from(schema.formResponses);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: 'completed', number: 1, respondentUserId: 'user_owner' });
    const moved = await db.select().from(schema.formResponseFiles);
    expect(moved.every((f) => f.storageKey.startsWith(`workspaces/${ORG}/weldforms/${form.id}/${done[0]!.id}/`))).toBe(true);
    expect(await world.privateBucket.get(moved[0]!.storageKey)).not.toBeNull();
    expect(eventNames(world.sent)).toEqual(['form_response:submitted']);
  });

  it('applies the field\'s limits, and stores a hidden member as a keyed hash only', async () => {
    const { publicId } = await publish(uploadDefinition(), { respondentMode: 'members', hideMemberIdentity: true });
    expect((await upload(publicId, 'b_cv', new File(['x'], 'a.exe', { type: 'application/x-msdownload' }))).status).toBe(415);
    expect((await upload(publicId, 'b_cv', new File([new Uint8Array(2 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }))).status).toBe(413);
    expect((await upload(publicId, 'b_name', pdf())).status).toBe(400);
    expect((await upload(publicId, 'b_cv', pdf('1.pdf'))).status).toBe(201);
    expect((await upload(publicId, 'b_cv', pdf('2.pdf'))).status).toBe(201);
    const third = await upload(publicId, 'b_cv', pdf('3.pdf'));
    expect([third.status, (await errorOf(third)).code]).toEqual([422, 'TOO_MANY_FILES']);
    const [row] = await db.select().from(schema.formResponses);
    expect(row).toMatchObject({ respondentUserId: null, respondentEmail: null });
    expect(row!.respondentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is only for members-only forms of this workspace that are open', async () => {
    const open = await publish(uploadDefinition());
    expect((await upload(open.publicId, 'b_cv', pdf())).status).toBe(404);
    expect((await upload('nosuchform', 'b_cv', pdf())).status).toBe(404);
    const members = await publish(uploadDefinition(), { respondentMode: 'members' });
    await forms().request(`${FORMS}/${members.form.id}/close`, json({}));
    expect((await upload(members.publicId, 'b_cv', pdf())).status).toBe(403);
    const body = new FormData();
    body.append('blockId', 'b_cv');
    const reopened = await forms().request(`${FORMS}/${members.form.id}/reopen`, json({}));
    expect(reopened.status).toBe(200);
    expect((await fill().request(`${FILL}/${members.publicId}/uploads`, { method: 'POST', body })).status).toBe(400);
  });
});
