/**
 * Integrations against pglite: the routes (settings validated against the form,
 * events, who they act as, a dry run) and the three ProcessResponse steps (CRM,
 * Desk, Flow) writing real rows of the other modules through their domain
 * packages: found-or-created person, company, list, activity; a ticket with
 * its attachments; a task with its files. Each step is retried to show it makes
 * its record once, and run as a member without the permission to show the skip.
 * Every route runs through the kit's harness, so the tests can be replayed
 * against the Rust backend; each ProcessResponse run goes through
 * `conformanceSweep` (job `forms-process-response`), which runs it on Rust
 * too and compares the events, and the assertions read Rust's rows.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import type { FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import integrationsRoutes from './routes/integrations';
import { crmStep } from './workflows/steps/crm';
import { deskStep } from './workflows/steps/desk';
import { flowStep } from './workflows/steps/flow';
import { inlineSteps, runProcessResponse } from './workflows/process-response';
import type { ProcessResponseParams } from './workflows/process-params';
import { ORG, WS, eventNames, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, type World } from './test/support';

// The conformance handles: in conformance mode the TypeScript run of a write
// gets the transaction it is rolled back in (the Rust run writes for real),
// and a ProcessResponse run on TypeScript gets a copy of the tenant (`dbs.tenant`).
const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(dbs.tenant),
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
  };
});

let db: Database;
let master: MasterDatabase;
let world: World;

const FORM = 'frm_int';
const RESPONSE = 'frs_int';
const params: ProcessResponseParams = { clerkOrgId: ORG, workspaceId: WS, formId: FORM, responseId: RESPONSE, mode: 'submit' };
const STEPS = [crmStep, deskStep, flowStep];

const definition = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_email', ref: 'email', type: 'email', title: 'Email', required: true, properties: {} },
    { id: 'b_name', ref: 'name', type: 'short_text', title: 'Name', properties: {} },
    { id: 'b_company', ref: 'company', type: 'short_text', title: 'Company', properties: {} },
    { id: 'b_phone', ref: 'phone', type: 'phone', title: 'Phone', properties: {} },
    { id: 'b_due', ref: 'due', type: 'date', title: 'Needed by', properties: {} },
    { id: 'b_msg', ref: 'msg', type: 'long_text', title: 'Message', properties: {} },
    { id: 'b_secret', ref: 'secret', type: 'short_text', title: 'Private', sensitive: true, properties: {} },
    { id: 'b_cv', ref: 'cv', type: 'file_upload', title: 'CV', properties: { maxFiles: 2, maxSizeMb: 1, accept: 'documents' } },
  ],
  hidden: [{ name: 'utm_source' }],
  endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
});

const crmConfig = {
  target: 'person',
  emailFieldId: 'b_email',
  createCompany: true,
  companyFieldId: 'b_company',
  mappings: [
    { blockId: 'b_name', crmField: 'firstName', mode: 'fill_empty' },
    { blockId: 'b_phone', crmField: 'directPhone', mode: 'overwrite' },
  ],
  tags: ['website'],
  logActivity: true,
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  shareMasterDb(master);
}, 120_000);

beforeEach(async () => {
  world = newWorld();
  await resetForms(db, master);
  await seedWorkspace(master);
  const t = schema;
  await db.delete(t.listMembers);
  await db.delete(t.lists);
  await db.delete(t.crmActivities);
  await db.delete(t.crmLeads);
  await db.delete(t.personCompanies);
  await db.delete(t.people);
  await db.delete(t.companies);
  await db.delete(t.deskMessages);
  await db.delete(t.deskConversations);
  await db.delete(t.tasks);
  await db.delete(t.projects);
  await db.delete(t.files);
  await db.delete(t.customFieldDefinitions);
  await db.delete(t.workspaceMembers);
  await db.insert(t.workspaceMembers).values([
    { id: 'wm_owner', userId: 'user_owner', email: 'owner@acme.test', name: 'Olivia', role: 'OWNER' },
    { id: 'wm_viewer', userId: 'user_viewer', email: 'viewer@acme.test', name: 'Victor', role: 'VIEWER' },
    { id: 'wm_other', userId: 'user_other', email: 'other@acme.test', name: 'Otto', role: 'OWNER' },
  ]);
  await db.insert(t.forms).values({ id: FORM, title: 'Contact us', definition, settings: {}, ownerUserId: 'user_owner', publicId: 'pubint0001', status: 'published' });
  await db.insert(t.formVersions).values({ id: 'fve_int', formId: FORM, number: 1, definition, publishedByUserId: 'user_owner' });
  await respond();
});

/** A completed response with answers, and one uploaded file in the private bucket. */
async function respond(answers: Record<string, unknown> = {}): Promise<void> {
  await db.delete(schema.formResponseFiles);
  await db.delete(schema.formResponses);
  await db.insert(schema.formResponses).values({
    id: RESPONSE,
    formId: FORM,
    versionId: 'fve_int',
    number: 7,
    status: 'completed',
    answers: {
      b_email: 'Ada@Acme-Corp.com',
      b_name: 'Ada',
      b_company: 'Acme Corp',
      b_phone: '+31 20 1234567',
      b_due: '2026-12-01',
      b_msg: 'Please call me back',
      b_secret: 'my password',
      ...answers,
    },
    hidden: { utm_source: 'newsletter' },
    respondentEmail: null,
    submittedAt: new Date('2026-11-01T10:00:00Z'),
  });
  const key = `workspaces/${ORG}/weldforms/${RESPONSE}/cv.pdf`;
  await world.privateBucket.put(key, new Uint8Array([1, 2, 3, 4]));
  await db.insert(schema.formResponseFiles).values({ id: 'ffl_cv', responseId: RESPONSE, formId: FORM, blockId: 'b_cv', kind: 'upload', storageKey: key, name: 'cv.pdf', contentType: 'application/pdf', sizeBytes: 4 });
}

const API = `/api/forms/forms/${FORM}/integrations`;
const api = (who?: Parameters<typeof memberApp>[4]) => memberApp('/api/forms/forms', integrationsRoutes, world, db, who);
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;

async function addIntegration(kind: string, config: Record<string, unknown>, who?: Parameters<typeof memberApp>[4]): Promise<FormIntegration> {
  const res = await api(who).request(API, json({ kind, config }));
  expect(res.status, await res.clone().text()).toBe(201);
  return data<FormIntegration>(res);
}

async function insertIntegration(id: string, kind: 'crm' | 'desk' | 'flow', config: Record<string, unknown>, createdByUserId = 'user_owner') {
  await db.insert(schema.formIntegrations).values({ id, formId: FORM, kind, config: config as never, createdByUserId });
}

/**
 * One ProcessResponse run with the three integration steps; in conformance
 * mode on Rust too (the test then sees Rust's rows and events).
 */
async function run(p: Partial<ProcessResponseParams> = {}) {
  const run = { ...params, ...p };
  await conformanceSweep({
    job: 'forms-process-response',
    now: new Date(),
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: world.env as unknown as Record<string, unknown>,
    workspaces: { [WS]: ORG },
    input: { params: run, steps: STEPS.map((s) => s.name) },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        await runProcessResponse(world.env, run, inlineSteps, STEPS);
        return {};
      } finally {
        dbs.tenant = db;
      }
    },
    // As the hub queue carries them: JSON (dates as ISO text).
    takeTypeScriptEvents: () => world.sent.splice(0).map((m) => JSON.parse(JSON.stringify(m)) as Record<string, unknown>),
    // The assertions on `world.sent` then read Rust's events, in the queue's shape.
    onRustEvents: (events) =>
      void world.sent.push(
        ...events.map((e) => ({ ...e, eventType: `${String(e.entityType)}:${String(e.action)}`, metadata: { workspaceId: e.workspaceId, userId: e.userId } }) as never),
      ),
  });
}

const actions = () => db.select().from(schema.formResponseActions).orderBy(schema.formResponseActions.integrationId);

describe('integration routes', () => {
  it('adds an integration after checking it against the form, and publishes events', async () => {
    const created = await addIntegration('crm', crmConfig);
    expect(created).toMatchObject({ kind: 'crm', enabled: true, formId: FORM, lastError: null, createdBy: { userId: 'user_owner', name: 'Olivia' } });
    expect(created.config).toMatchObject({ emailFieldId: 'b_email', tags: ['website'] });

    const list = await data<FormIntegration[]>(await api().request(API));
    expect(list.map((i) => i.id)).toEqual([created.id]);

    const off = await api().request(`${API}/${created.id}`, json({ enabled: false }, 'PATCH'));
    expect((await data<FormIntegration>(off)).enabled).toBe(false);
    expect((await api().request(`${API}/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await data<FormIntegration[]>(await api().request(API))).toEqual([]);
    expect(eventNames(world.sent)).toEqual(['form_integration:created', 'form_integration:updated', 'form_integration:deleted']);
  });

  it('refuses settings that do not fit the form with 422 INVALID_CONFIG and the fields at fault', async () => {
    const res = await api().request(
      API,
      json({
        kind: 'crm',
        config: { ...crmConfig, emailFieldId: 'b_name', mappings: [{ blockId: 'b_nope', crmField: 'firstName' }, { blockId: 'b_name', crmField: 'shoeSize' }] },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { fields: Record<string, string> } } };
    expect(body.error.code).toBe('INVALID_CONFIG');
    expect(Object.keys(body.error.details.fields).sort()).toEqual(['emailFieldId', 'mappings.0', 'mappings.1']);

    const desk = await api().request(API, json({ kind: 'desk', config: { subject: '{{field:nope}}', departmentId: 'dep_gone' } }));
    expect(desk.status).toBe(422);
    const fields = ((await desk.json()) as { error: { details: { fields: Record<string, string> } } }).error.details.fields;
    expect(Object.keys(fields).sort()).toEqual(['departmentId', 'subject']);

    const flow = await api().request(API, json({ kind: 'flow', config: { projectId: 'prj_gone', dueDateFieldId: 'b_name' } }));
    expect(flow.status).toBe(422);
    expect(await db.select().from(schema.formIntegrations)).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it('knows custom fields, lists and teams that exist', async () => {
    await db.insert(schema.customFieldDefinitions).values({ id: 'cfd_size', entityType: 'person', name: 'Size', slug: 'size', fieldType: 'number' });
    await db.insert(schema.lists).values({ id: 'lst_news', name: 'News', kind: 'person' } as never);
    await db.insert(schema.lists).values({ id: 'lst_co', name: 'Companies', kind: 'company' } as never);
    await addIntegration('crm', { ...crmConfig, listId: 'lst_news', mappings: [{ blockId: 'b_msg', crmField: 'custom:cfd_size' }] });
    const wrongKind = await api().request(API, json({ kind: 'crm', config: { ...crmConfig, listId: 'lst_co' } }));
    expect(wrongKind.status).toBe(422);
    const unknown = await api().request(API, json({ kind: 'crm', config: { ...crmConfig, mappings: [{ blockId: 'b_msg', crmField: 'custom:cfd_gone' }] } }));
    expect(unknown.status).toBe(422);
  });

  it('makes whoever changes the settings the member the steps act as', async () => {
    const created = await addIntegration('crm', crmConfig);
    await db.update(schema.formIntegrations).set({ lastError: 'old' });
    const patched = await api({ userId: 'user_other' }).request(`${API}/${created.id}`, json({ config: { ...crmConfig, tags: [] } }, 'PATCH'));
    const dto = await data<FormIntegration>(patched);
    expect(dto.createdBy.userId).toBe('user_other');
    expect(dto.lastError).toBeNull();
    // Only switching it on or off does not hand it over.
    await api({ userId: 'user_owner' }).request(`${API}/${created.id}`, json({ enabled: false }, 'PATCH'));
    const [row] = await db.select().from(schema.formIntegrations);
    expect(row!.createdByUserId).toBe('user_other');
  });

  it('needs forms:update, and a form the member may edit', async () => {
    const readOnly = { permissions: ['forms:read'] };
    expect((await api(readOnly).request(API, json({ kind: 'crm', config: crmConfig }))).status).toBe(403);
    expect((await api(readOnly).request(API)).status).toBe(200);
    expect((await api({ permissions: [] }).request(API)).status).toBe(403);
    expect((await api().request(`/api/forms/forms/frm_missing/integrations`)).status).toBe(404);
    const missing = await api().request(`${API}/fig_missing`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('tests an integration against the latest completed response without writing anything', async () => {
    const crm = await addIntegration('crm', crmConfig);
    const res = await api().request(`${API}/${crm.id}/test`, json({}));
    expect(await data(res)).toEqual({ ok: true, message: expect.stringContaining('would create the person ada@acme-corp.com') });
    const desk = await addIntegration('desk', { subject: '{{form:title}} #{{response:number}}: {{field:name}}' });
    expect(await data(await api().request(`${API}/${desk.id}/test`, json({})))).toEqual({ ok: true, message: expect.stringContaining('"Contact us #7: Ada"') });
    expect(await db.select().from(schema.people)).toEqual([]);
    expect(await db.select().from(schema.deskConversations)).toEqual([]);

    await db.delete(schema.formResponseFiles);
    await db.delete(schema.formResponses);
    expect(await data(await api().request(`${API}/${crm.id}/test`, json({})))).toMatchObject({ ok: false });
  });

  it('says in the test when the member who set it up may not do it', async () => {
    await insertIntegration('fig_v', 'desk', { subject: 'x' }, 'user_viewer');
    const result = await data<{ ok: boolean; message: string }>(await api().request(`${API}/fig_v/test`, json({})));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('tickets:create');
  });
});

describe('CRM step', () => {
  async function setUp(config: Record<string, unknown> = crmConfig, user = 'user_owner') {
    await db.insert(schema.lists).values({ id: 'lst_news', name: 'News', kind: 'person' } as never);
    await insertIntegration('fig_crm', 'crm', { ...config, listId: 'lst_news' }, user);
  }

  it('creates the person, their company, a list membership and an activity, and ties the response to them', async () => {
    await setUp();
    await run();
    const [person] = await db.select().from(schema.people);
    expect(person).toMatchObject({ email: 'ada@acme-corp.com', firstName: 'Ada', directPhone: '+31 20 1234567', tags: ['website'], ownerId: 'user_owner', inCrm: true });
    const [company] = await db.select().from(schema.companies);
    expect(company).toMatchObject({ name: 'Acme Corp', website: expect.stringContaining('acme-corp.com') });
    expect(await db.select().from(schema.personCompanies)).toMatchObject([{ personId: person!.id, companyId: company!.id, isPrimary: true }]);
    expect(await db.select().from(schema.listMembers)).toMatchObject([{ listId: 'lst_news', entityId: person!.id }]);
    const [activity] = await db.select().from(schema.crmActivities);
    expect(activity).toMatchObject({ type: 'note', subject: 'Submitted Contact us', personId: person!.id, assignedToId: 'user_owner' });
    expect(activity!.description).toBe(`https://app.test/weldforms/${FORM}/results?tab=responses&response=${RESPONSE}`);
    const [response] = await db.select().from(schema.formResponses);
    expect(response!.personId).toBe(person!.id);
    expect(await actions()).toMatchObject([{ integrationId: 'fig_crm', status: 'done', entityType: 'person', entityId: person!.id }]);
    const types = world.sent.map((m) => m.eventType);
    expect(types).toContain('person:created');
    expect(types).toContain('activity:created');
  });

  it('is safe to run again: one person, one company, one activity, one list entry', async () => {
    await setUp();
    await run();
    await run();
    expect(await db.select().from(schema.people)).toHaveLength(1);
    expect(await db.select().from(schema.companies)).toHaveLength(1);
    expect(await db.select().from(schema.crmActivities)).toHaveLength(1);
    expect(await db.select().from(schema.listMembers)).toHaveLength(1);
    expect(await actions()).toMatchObject([{ attempts: 2, status: 'done' }]);
  });

  it('fills empty fields only on an existing person, and overwrites where the mapping says so', async () => {
    await setUp();
    await db.insert(schema.people).values({ id: 'per_ada', email: 'ada@acme-corp.com', firstName: 'Augusta', directPhone: '0000', inCrm: true, displayName: 'Augusta', createdAt: new Date(), updatedAt: new Date() } as never);
    await run();
    const [person] = await db.select().from(schema.people);
    expect(await db.select().from(schema.people)).toHaveLength(1);
    expect(person).toMatchObject({ id: 'per_ada', firstName: 'Augusta', directPhone: '+31 20 1234567' });
    expect(person!.tags).toEqual(['website']);
    expect(await actions()).toMatchObject([{ entityId: 'per_ada' }]);
  });

  it('on an edited response updates the person it made', async () => {
    await setUp({ ...crmConfig, mappings: [{ blockId: 'b_phone', crmField: 'directPhone', mode: 'overwrite' }] });
    await run();
    await respond({ b_phone: '+31 6 9999999' });
    await run({ mode: 'update' });
    const people = await db.select().from(schema.people);
    expect(people).toHaveLength(1);
    expect(people[0]!.directPhone).toBe('+31 6 9999999');
    const subjects = (await db.select().from(schema.crmActivities)).map((a) => a.subject).sort();
    expect(subjects).toEqual(['Submitted Contact us', 'Updated response to Contact us']);
  });

  it('promotes a hidden mail identity and writes custom fields by slug', async () => {
    await db.insert(schema.customFieldDefinitions).values({ id: 'cfd_note', entityType: 'person', name: 'Note', slug: 'note', fieldType: 'text' });
    await setUp({ ...crmConfig, mappings: [{ blockId: 'b_msg', crmField: 'custom:cfd_note', mode: 'fill_empty' }] });
    await db.insert(schema.people).values({ id: 'per_mail', email: 'ada@acme-corp.com', inCrm: false, displayName: 'ada', createdAt: new Date(), updatedAt: new Date() } as never);
    await run();
    const people = await db.select().from(schema.people);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: 'per_mail', inCrm: true });
    expect((people[0] as { customFields?: Record<string, unknown> }).customFields).toMatchObject({ note: 'Please call me back' });
  });

  it('creates a lead instead, with the mapped contact fields', async () => {
    await insertIntegration('fig_lead', 'crm', {
      target: 'lead',
      emailFieldId: 'b_email',
      createCompany: true,
      companyFieldId: 'b_company',
      mappings: [{ blockId: 'b_name', crmField: 'firstName' }, { blockId: 'b_phone', crmField: 'directPhone' }],
      logActivity: true,
    });
    await run();
    await run();
    const leads = await db.select().from(schema.crmLeads);
    expect(leads).toMatchObject([{ email: 'ada@acme-corp.com', firstName: 'Ada', phone: '+31 20 1234567', companyName: 'Acme Corp', channel: 'weldforms' }]);
    expect(await db.select().from(schema.people)).toEqual([]);
    expect(await db.select().from(schema.crmActivities)).toMatchObject([{ leadId: leads[0]!.id, relatedTo: 'lead' }]);
    expect(await actions()).toMatchObject([{ entityType: 'lead', entityId: leads[0]!.id }]);
  });

  it('skips with the reason, shown on the integration, when its creator may not create people', async () => {
    await setUp(crmConfig, 'user_viewer');
    await run();
    expect(await db.select().from(schema.people)).toEqual([]);
    const [action] = await actions();
    expect(action).toMatchObject({ status: 'skipped' });
    expect(action!.error).toContain('people:create');
    const [row] = await db.select().from(schema.formIntegrations);
    expect(row!.lastError).toContain('people:create');
  });

  it('skips for a creator who left the workspace', async () => {
    await setUp(crmConfig, 'user_gone');
    await run();
    expect(await actions()).toMatchObject([{ status: 'skipped', error: expect.stringContaining('no longer in the workspace') }]);
  });

  it('skips when the response has no email address', async () => {
    await setUp();
    await respond({ b_email: '' });
    await run();
    expect(await actions()).toMatchObject([{ status: 'skipped', error: expect.stringContaining('no email address') }]);
    expect(await db.select().from(schema.people)).toEqual([]);
  });

  it('leaves free mail domains without a company, and finds a company by its domain', async () => {
    await insertIntegration('fig_crm', 'crm', { ...crmConfig, companyFieldId: undefined });
    await db.insert(schema.companies).values({ id: 'co_acme', name: 'Acme', displayName: 'Acme', website: 'https://www.acme-corp.com', status: 'customer', createdAt: new Date(), updatedAt: new Date() } as never);
    await run();
    expect(await db.select().from(schema.companies)).toHaveLength(1);
    expect(await db.select().from(schema.personCompanies)).toMatchObject([{ companyId: 'co_acme' }]);

    await db.delete(schema.personCompanies);
    await db.delete(schema.people);
    await respond({ b_email: 'ada@gmail.com' });
    await run({ responseId: RESPONSE });
    expect(await db.select().from(schema.personCompanies)).toEqual([]);
  });
});

describe('Desk step', () => {
  const deskConfig = { subject: '{{form:title}} #{{response:number}}', body: '{{field:name}} wrote: {{field:msg}}\n{{response:url}}', priority: 'high', tags: ['web'], attachFiles: true };

  it('opens a ticket with the templates, the requester, priority, tags and the attachments', async () => {
    await insertIntegration('fig_desk', 'desk', { ...deskConfig, requesterFieldId: 'b_email' });
    await run();
    const [conversation] = await db.select().from(schema.deskConversations);
    expect(conversation).toMatchObject({ title: 'Contact us #7', channel: 'api', email: 'ada@acme-corp.com', externalId: `form-response:${RESPONSE}:fig_desk` });
    expect(conversation!.priority).toBe('high');
    expect(conversation!.tags).toEqual(['web']);
    const messages = await db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversation!.id));
    const first = messages.find((m) => m.kind === 'message')!;
    expect(first.body).toBe(`Ada wrote: Please call me back\nhttps://app.test/weldforms/${FORM}/results?tab=responses&response=${RESPONSE}`);
    expect(first.attachments).toMatchObject([{ name: 'cv.pdf', contentType: 'application/pdf', filesize: 4, url: expect.stringMatching(/^https:\/\/cdn\.test\/desk\/org_forms\/forms\/frs_int\/.+\/cv\.pdf$/) }]);
    expect(await actions()).toMatchObject([{ status: 'done', entityType: 'desk_conversation', entityId: conversation!.id }]);
    expect(world.sent.map((m) => m.eventType)).toContain('desk_conversation:created');
  });

  it('writes every answer as lines when the body is empty, leaving sensitive ones out', async () => {
    await insertIntegration('fig_desk', 'desk', { subject: 'Hello', body: '', priority: 'normal', tags: [], attachFiles: false });
    await run();
    const [message] = await db.select().from(schema.deskMessages);
    expect(message!.body).toContain('Name: Ada');
    expect(message!.body).toContain('Message: Please call me back');
    expect(message!.body).not.toContain('my password');
    expect(message!.attachments).toBeNull();
  });

  it('opens one ticket however often it runs, and leaves it alone when the response is edited', async () => {
    await insertIntegration('fig_desk', 'desk', deskConfig);
    await run();
    await run();
    await run({ mode: 'update' });
    expect(await db.select().from(schema.deskConversations)).toHaveLength(1);
    expect(await db.select().from(schema.deskMessages).where(eq(schema.deskMessages.kind, 'message'))).toHaveLength(1);
  });

  it('skips for a creator without tickets:create, and for a department that is gone', async () => {
    await insertIntegration('fig_desk', 'desk', deskConfig, 'user_viewer');
    await insertIntegration('fig_dep', 'desk', { ...deskConfig, departmentId: 'dep_gone' });
    await run();
    expect(await db.select().from(schema.deskConversations)).toEqual([]);
    const rows = await actions();
    expect(rows.map((r) => [r.integrationId, r.status])).toEqual([['fig_dep', 'skipped'], ['fig_desk', 'skipped']]);
    expect(rows.find((r) => r.integrationId === 'fig_desk')!.error).toContain('tickets:create');
  });
});

describe('Flow step', () => {
  const flowConfig = { title: '{{form:title}} #{{response:number}}: {{field:name}}', description: '{{field:msg}}', dueDateFieldId: 'b_due', labels: ['inbound'], attachFiles: true };

  async function project() {
    const now = new Date();
    await db.insert(schema.projects).values({ id: 'prj_site', name: 'Website', createdAt: now, updatedAt: now } as never);
  }

  it('creates a task in the project with title, description, assignee, due date, labels and the uploads', async () => {
    await project();
    await insertIntegration('fig_flow', 'flow', { ...flowConfig, projectId: 'prj_site', assigneeUserId: 'user_other' });
    await run();
    const [task] = await db.select().from(schema.tasks);
    expect(task).toMatchObject({ title: 'Contact us #7: Ada', description: 'Please call me back', projectId: 'prj_site', assigneeId: 'user_other', labels: ['inbound'], sourceType: 'form_response', sourceId: RESPONSE, reporterId: 'user_owner' });
    expect(task!.dueDate!.toISOString().slice(0, 10)).toBe('2026-12-01');
    const attached = await db.select().from(schema.files).where(eq(schema.files.entityId, task!.id));
    expect(attached).toMatchObject([{ fileName: 'cv.pdf', entityType: 'task', mimeType: 'application/pdf', fileSize: 4 }]);
    expect(await world.privateBucket.get(attached[0]!.storagePath)).not.toBeNull();
    expect(await actions()).toMatchObject([{ status: 'done', entityType: 'task', entityId: task!.id }]);
    expect(world.sent.map((m) => m.eventType)).toContain('project_task:created');
  });

  it('makes a personal task of the member who set it up when there is no project or assignee', async () => {
    await insertIntegration('fig_flow', 'flow', { ...flowConfig, attachFiles: false });
    await run();
    const [task] = await db.select().from(schema.tasks);
    expect(task).toMatchObject({ projectId: null, assigneeId: 'user_owner' });
  });

  it('makes one task however often it runs, and resumes into the same task after a failure', async () => {
    await insertIntegration('fig_flow', 'flow', flowConfig);
    await run();
    await run();
    await run({ mode: 'update' });
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect(await db.select().from(schema.files)).toHaveLength(1);

    // A run that died after the task existed (remembered on the action row) goes on with that task.
    await db.delete(schema.files);
    await run();
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect(await db.select().from(schema.files)).toHaveLength(1);
  });

  it('skips for a creator without write access to the project, and for one without tasks:create', async () => {
    await project();
    await insertIntegration('fig_flow', 'flow', { ...flowConfig, projectId: 'prj_site' }, 'user_viewer');
    await run();
    expect(await db.select().from(schema.tasks)).toEqual([]);
    expect(await actions()).toMatchObject([{ status: 'skipped', error: expect.stringContaining('tasks:create') }]);
  });

  it('skips when the project was deleted', async () => {
    await project();
    await db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, 'prj_site'));
    await insertIntegration('fig_flow', 'flow', { ...flowConfig, projectId: 'prj_site' });
    await run();
    expect(await actions()).toMatchObject([{ status: 'skipped', error: expect.stringContaining('no longer exists') }]);
  });
});

describe('all three together', () => {
  it('one submission updates a person with an activity, opens a ticket and creates a task; a disabled integration does nothing', async () => {
    await insertIntegration('fig_a', 'crm', crmConfig);
    await insertIntegration('fig_b', 'desk', { subject: '{{form:title}}' });
    await insertIntegration('fig_c', 'flow', { title: 'Follow up {{field:name}}' });
    await db.insert(schema.formIntegrations).values({ id: 'fig_off', formId: FORM, kind: 'flow', config: { title: 'Never' } as never, enabled: false, createdByUserId: 'user_owner' });
    await run();
    expect((await actions()).map((a) => [a.integrationId, a.status])).toEqual([['fig_a', 'done'], ['fig_b', 'done'], ['fig_c', 'done']]);
    expect(await db.select().from(schema.people)).toHaveLength(1);
    expect(await db.select().from(schema.deskConversations)).toHaveLength(1);
    expect((await db.select().from(schema.tasks)).map((t) => t.title)).toEqual(['Follow up Ada']);
  });
});
