/**
 * The results side of WeldForms against pglite: the responses list (status,
 * abandoned, dates, search, version, person, answer filters in SQL, sort, cursor),
 * one response with its actions, columns merged across versions, summary,
 * insights, CSV and XLSX export, deleting (one, many, a respondent's everything),
 * file downloads, retrying an integration step and a person's responses across
 * forms. Every route runs through the kit's test harness, so the same tests can
 * be replayed against the Rust backend.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { openZip } from '@weldsuite/zip-xml';
import type {
  EraseRespondentResult,
  FormDetail,
  FormFieldSummary,
  FormInsights,
  FormResponseColumn,
  FormResponseDetail,
  FormResponseDto,
  FormResultsSummary,
  PersonFormResponse,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import { countersFor } from './lib/counters';
import crossRoutes from './routes/cross';
import formsRoutes from './routes/forms';
import responsesRoutes from './routes/responses';
import { ORG, WS, eventNames, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, simpleDefinition, type World } from './test/support';

// The conformance handles: in conformance mode the TypeScript run of a write
// gets the transaction it is rolled back in (the Rust run writes for real).
const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
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

const FORMS = '/api/forms/forms';
const CROSS = '/api/forms';
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const page = async <T>(res: Response) => (await res.json()) as { data: T[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };

const forms = (who?: Parameters<typeof memberApp>[4]) => memberApp(FORMS, formsRoutes, world, db, who);
const results = (who?: Parameters<typeof memberApp>[4]) => memberApp(FORMS, responsesRoutes, world, db, who);
const cross = (who?: Parameters<typeof memberApp>[4]) => memberApp(CROSS, crossRoutes, world, db, who);

/** One form with every field type the results read, plus a sensitive note and hidden `utm_source`. */
function resultsDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [
      { id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', required: true, properties: {} },
      { id: 'b_note', ref: 'note', type: 'short_text', title: 'Private note', sensitive: true, properties: {} },
      {
        id: 'b_plan',
        ref: 'plan',
        type: 'multiple_choice',
        title: 'Which plan?',
        properties: { allowOther: true, choices: [{ id: 'c_free', label: 'Free', score: 1 }, { id: 'c_pro', label: 'Pro', score: 5 }] },
      },
      { id: 'b_rating', ref: 'rating', type: 'rating', title: 'Rate us', properties: { steps: 5 } },
      { id: 'b_nps', ref: 'nps', type: 'nps', title: 'Recommend us?', properties: {} },
      { id: 'b_agree', ref: 'agree', type: 'yes_no', title: 'Happy?', properties: {} },
      { id: 'b_contact', ref: 'contact', type: 'contact_info', title: 'Contact', properties: {} },
      {
        id: 'b_rank',
        ref: 'rank',
        type: 'ranking',
        title: 'Rank these',
        properties: { choices: [{ id: 'r_a', label: 'Speed' }, { id: 'r_b', label: 'Price' }] },
      },
    ],
    hidden: [{ name: 'utm_source' }],
    endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
  });
}

async function publishForm(definition: FormDefinition = resultsDefinition(), title = 'Survey'): Promise<FormDetail> {
  const created = await data<FormDetail>(await forms().request(FORMS, json({ title })));
  const saved = await data<FormDetail>(await forms().request(`${FORMS}/${created.id}`, json({ revision: created.revision, definition }, 'PATCH')));
  const { form } = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${saved.id}/publish`, json({})));
  world.sent.length = 0;
  return form;
}

let seq = 0;
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 10, day, hour));

/** A completed response straight into the tenant DB (the submit path has its own tests). */
async function addResponse(form: FormDetail, over: Partial<typeof schema.formResponses.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const id = over.id ?? `frs_r${seq}`;
  const status = over.status ?? 'completed';
  await db.insert(schema.formResponses).values({
    id,
    formId: form.id,
    versionId: form.publishedVersion!.id,
    number: status === 'completed' ? seq : null,
    status,
    answers: {},
    startedAt: at(1),
    submittedAt: status === 'completed' ? at(1, 11) : null,
    durationMs: status === 'completed' ? 60_000 : null,
    updatedAt: at(1, 11),
    ...over,
  });
  if (status === 'completed') await db.update(schema.forms).set({ responseCount: seq }).where(eq(schema.forms.id, form.id));
  return id;
}

beforeEach(async () => {
  world = newWorld();
  seq = 0;
  await resetForms(db, master);
  await seedWorkspace(master);
});

describe('responses list', () => {
  let form: FormDetail;
  beforeEach(async () => {
    form = await publishForm();
    await addResponse(form, { id: 'frs_ann', respondentEmail: 'ann@example.com', answers: { b_name: 'Ann', b_plan: { choiceIds: ['c_free'] }, b_agree: true }, score: 1, searchText: 'ann', personId: 'per_ann', submittedAt: at(2), startedAt: at(2), metadata: { source: 'link', device: 'desktop' } });
    await addResponse(form, { id: 'frs_bob', respondentEmail: 'bob@example.com', answers: { b_name: 'Bob', b_plan: { choiceIds: ['c_pro'] }, b_rating: 4, b_agree: false, b_contact: { firstName: 'Bob', email: 'bob@acme.nl' } }, score: 5, searchText: 'bob', submittedAt: at(3), startedAt: at(3), hidden: { utm_source: 'news' } });
    await addResponse(form, { id: 'frs_cy', answers: { b_name: 'Cy', b_plan: { choiceIds: ['c_pro'], other: 'Team plan' }, b_rating: 5 }, score: 5, searchText: 'cy team plan', submittedAt: at(4), startedAt: at(4) });
    await addResponse(form, { id: 'frs_fresh', status: 'in_progress', answers: { b_name: 'Dee' }, startedAt: new Date(), updatedAt: new Date() });
    await addResponse(form, { id: 'frs_old', status: 'in_progress', answers: { b_name: 'Eve' }, startedAt: at(5), updatedAt: at(5) });
  });

  const list = async (query = '') => page<FormResponseDto>(await results().request(`${FORMS}/${form.id}/responses${query}`));
  const ids = (rows: FormResponseDto[]) => rows.map((r) => r.id);

  it('lists newest first with the form-level count, and computes abandoned on read', async () => {
    const all = await list();
    expect(all.pagination.totalCount).toBe(5);
    expect(ids(all.data)).toEqual(['frs_fresh', 'frs_old', 'frs_cy', 'frs_bob', 'frs_ann']);
    const old = all.data.find((r) => r.id === 'frs_old')!;
    expect(old).toMatchObject({ status: 'in_progress', abandoned: true, number: null });
    expect(all.data.find((r) => r.id === 'frs_fresh')!.abandoned).toBe(false);
    expect(all.data.find((r) => r.id === 'frs_ann')).toMatchObject({ versionNumber: 1, respondentEmail: 'ann@example.com', score: 1, personId: 'per_ann', metadata: { source: 'link', device: 'desktop' }, files: [] });
  });

  it('filters on status, dates, version, person and search text', async () => {
    expect(ids((await list('?status=completed')).data)).toEqual(['frs_cy', 'frs_bob', 'frs_ann']);
    expect(ids((await list('?status=in_progress')).data).sort()).toEqual(['frs_fresh', 'frs_old']);
    expect(ids((await list(`?status=completed&from=${at(3, 0).toISOString()}&to=${at(3, 23).toISOString()}`)).data)).toEqual(['frs_bob']);
    expect(ids((await list('?personId=per_ann')).data)).toEqual(['frs_ann']);
    expect(ids((await list('?q=team')).data)).toEqual(['frs_cy']);
    expect(ids((await list('?q=BOB@EXAMPLE')).data)).toEqual(['frs_bob']);
    expect((await list(`?versionId=${form.publishedVersion!.id}`)).pagination.totalCount).toBe(5);
    expect((await list('?versionId=fve_none')).pagination.totalCount).toBe(0);
  });

  it('evaluates answer filters in SQL: choices, text, numbers, booleans, contact parts, answered', async () => {
    const f = (filters: unknown[]) => list(`?filters=${encodeURIComponent(JSON.stringify(filters))}`);
    expect(ids((await f([{ blockId: 'b_plan', operator: 'any_of', value: ['c_pro'] }])).data)).toEqual(['frs_cy', 'frs_bob']);
    expect(ids((await f([{ blockId: 'b_plan', operator: 'none_of', value: ['c_pro'] }])).data).sort()).toEqual(['frs_ann', 'frs_fresh', 'frs_old']);
    expect(ids((await f([{ blockId: 'b_plan', operator: 'contains', value: 'team' }])).data)).toEqual(['frs_cy']);
    expect(ids((await f([{ blockId: 'b_name', operator: 'contains', value: 'an' }])).data)).toEqual(['frs_ann']);
    expect(ids((await f([{ blockId: 'b_name', operator: 'is', value: 'bob' }])).data)).toEqual(['frs_bob']);
    expect(ids((await f([{ blockId: 'b_name', operator: 'is_not', value: 'bob' }])).data).sort()).toEqual(['frs_ann', 'frs_cy', 'frs_fresh', 'frs_old']);
    expect(ids((await f([{ blockId: 'b_rating', operator: 'greater_than', value: 4 }])).data)).toEqual(['frs_cy']);
    expect(ids((await f([{ blockId: 'b_rating', operator: 'is', value: 4 }])).data)).toEqual(['frs_bob']);
    expect(ids((await f([{ blockId: 'b_agree', operator: 'is', value: true }])).data)).toEqual(['frs_ann']);
    expect(ids((await f([{ blockId: 'b_agree', operator: 'is', value: false }])).data)).toEqual(['frs_bob']);
    expect(ids((await f([{ blockId: 'b_contact', part: 'email', operator: 'contains', value: 'acme' }])).data)).toEqual(['frs_bob']);
    expect(ids((await f([{ blockId: 'b_rating', operator: 'is_answered' }])).data)).toEqual(['frs_cy', 'frs_bob']);
    expect(ids((await f([{ blockId: 'b_rating', operator: 'is_empty' }])).data).sort()).toEqual(['frs_ann', 'frs_fresh', 'frs_old']);
    // Filters combine with AND, and with the other conditions.
    expect(ids((await list(`?status=completed&filters=${encodeURIComponent(JSON.stringify([{ blockId: 'b_plan', operator: 'any_of', value: ['c_pro'] }, { blockId: 'b_rating', operator: 'greater_than', value: 4 }]))}`)).data)).toEqual(['frs_cy']);
  });

  it('refuses filters it cannot read with 400', async () => {
    expect((await results().request(`${FORMS}/${form.id}/responses?filters=nope`)).status).toBe(400);
    expect((await results().request(`${FORMS}/${form.id}/responses?filters=${encodeURIComponent(JSON.stringify([{ blockId: 'b_rank', operator: 'is', value: 'x' }]))}`)).status).toBe(400);
    expect((await results().request(`${FORMS}/${form.id}/responses?filters=${encodeURIComponent(JSON.stringify([{ blockId: 'b_name', operator: 'bogus' }]))}`)).status).toBe(400);
  });

  it('sorts by score and date and pages with a cursor', async () => {
    expect(ids((await list('?status=completed&sort=oldest')).data)).toEqual(['frs_ann', 'frs_bob', 'frs_cy']);
    expect(ids((await list('?status=completed&sort=score_asc')).data)[0]).toBe('frs_ann');
    expect(ids((await list('?status=completed&sort=score_desc')).data)[2]).toBe('frs_ann');
    const first = await list('?limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.pagination).toMatchObject({ totalCount: 5, hasMore: true });
    const second = await list(`?limit=2&cursor=${first.pagination.cursor}`);
    const third = await list(`?limit=2&cursor=${second.pagination.cursor}`);
    expect([...first.data, ...second.data, ...third.data]).toHaveLength(5);
    expect(new Set([...first.data, ...second.data, ...third.data].map((r) => r.id)).size).toBe(5);
    expect(third.pagination).toMatchObject({ hasMore: false, cursor: null });
  });

  it('is gated by form_responses:read and by the form being visible to the member', async () => {
    const noRead = await results({ permissions: ['forms:read'] }).request(`${FORMS}/${form.id}/responses`);
    expect(noRead.status).toBe(403);
    // A restricted form the member is not on does not exist for them.
    const restricted = await data<FormDetail>(await forms().request(`${FORMS}/${form.id}`, json({ revision: form.revision, access: 'restricted' }, 'PATCH')));
    expect(restricted.access).toBe('restricted');
    expect((await results({ userId: 'user_other', permissions: ['forms:read', 'form_responses:read'] }).request(`${FORMS}/${form.id}/responses`)).status).toBe(404);
    // `results` access reads answers; the owner always can.
    await db.insert(schema.formAccess).values({ id: 'fac_1', formId: form.id, userId: 'user_other', role: 'results' });
    expect((await results({ userId: 'user_other', permissions: ['forms:read', 'form_responses:read'] }).request(`${FORMS}/${form.id}/responses`)).status).toBe(200);
  });
});

describe('one response', () => {
  it('answers with its actions, 404 for another form or an unknown id', async () => {
    const form = await publishForm();
    const other = await publishForm(simpleDefinition(), 'Other');
    const id = await addResponse(form, { answers: { b_name: 'Ann' }, hidden: { utm_source: 'mail' } });
    await db.insert(schema.formIntegrations).values({ id: 'fig_1', formId: form.id, kind: 'crm', config: {}, createdByUserId: 'user_owner' });
    await db.insert(schema.formResponseActions).values({ id: 'fra_1', responseId: id, formId: form.id, integrationId: 'fig_1', kind: 'crm', status: 'failed', error: 'CRM is down', attempts: 3 });

    const detail = await data<FormResponseDetail>(await results().request(`${FORMS}/${form.id}/responses/${id}`));
    expect(detail).toMatchObject({ id, hidden: { utm_source: 'mail' }, answers: { b_name: 'Ann' } });
    expect(detail.actions).toMatchObject([{ id: 'fra_1', kind: 'crm', status: 'failed', error: 'CRM is down', attempts: 3 }]);
    expect((await results().request(`${FORMS}/${other.id}/responses/${id}`)).status).toBe(404);
    expect((await results().request(`${FORMS}/${form.id}/responses/frs_missing`)).status).toBe(404);
  });
});

describe('columns', () => {
  it('merges the fields of every version by block id and adds the metadata columns', async () => {
    const form = await publishForm(simpleDefinition());
    const draft = await data<FormDetail>(await forms().request(`${FORMS}/${form.id}`));
    // Version 2 drops the name question and adds a contact block with parts.
    const v2 = formDefinitionSchema.parse({
      blocks: [
        { id: 'b_name', ref: 'name', type: 'short_text', title: 'Full name', properties: {} },
        { id: 'b_contact', ref: 'contact', type: 'contact_info', title: 'Contact', properties: { fields: { phone: { enabled: false, required: false } } } },
      ],
      hidden: [{ name: 'utm_source' }, { name: 'status' }],
      endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
    });
    await forms().request(`${FORMS}/${form.id}`, json({ revision: draft.revision, definition: v2 }, 'PATCH'));
    await forms().request(`${FORMS}/${form.id}/publish`, json({}));

    const columns = await data<FormResponseColumn[]>(await results().request(`${FORMS}/${form.id}/columns`));
    const keys = columns.map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(['number', 'submittedAt', 'email']);
    expect(columns.find((c) => c.key === 'b_name')).toMatchObject({ blockId: 'b_name', label: 'Full name', type: 'short_text', versions: [1, 2] });
    expect(keys).toEqual(expect.arrayContaining(['b_contact.firstName', 'b_contact.email', 'b_contact.company', 'utm_source']));
    expect(keys).not.toContain('b_contact.phone');
    expect(columns.find((c) => c.key === 'b_contact.email')).toMatchObject({ blockId: 'b_contact', part: 'email', versions: [2] });
    // A hidden field named like a metadata column would be shadowed by it in the table.
    expect(keys.filter((k) => k === 'status')).toHaveLength(1);
    expect(columns.find((c) => c.key === 'utm_source')).toMatchObject({ type: 'hidden', versions: [2] });
    expect(keys).toEqual(expect.arrayContaining(['score', 'duration', 'status', 'startedAt', 'version', 'source', 'device', 'country', 'referrer']));
    expect(columns.find((c) => c.key === 'status')!.blockId).toBeUndefined();
  });
});

describe('summary', () => {
  it('counts per field by kind, with percentages, averages and the latest text answers', async () => {
    const form = await publishForm();
    await addResponse(form, { answers: { b_name: 'Ann', b_plan: { choiceIds: ['c_free'] }, b_rating: 3, b_nps: 10, b_agree: true, b_rank: ['r_a', 'r_b'] }, score: 1, submittedAt: at(2) });
    await addResponse(form, { answers: { b_name: 'Bob', b_plan: { choiceIds: ['c_pro'] }, b_rating: 5, b_nps: 9, b_agree: false, b_rank: ['r_b', 'r_a'] }, score: 5, submittedAt: at(3) });
    await addResponse(form, { answers: { b_name: 'Cy', b_plan: { choiceIds: ['c_pro'], other: 'Team' }, b_rating: 4, b_nps: 3, b_agree: true, b_rank: ['r_a', 'r_b'] }, score: 5, submittedAt: at(4) });
    await addResponse(form, { status: 'in_progress', answers: { b_name: 'Dee' } });

    const summary = await data<FormResultsSummary>(await results().request(`${FORMS}/${form.id}/summary`));
    expect(summary).toMatchObject({ totalResponses: 3, averageScore: 3.67 });
    const by = (id: string) => summary.fields.find((f) => f.blockId === id) as FormFieldSummary;

    expect(by('b_plan')).toMatchObject({ kind: 'choice', answered: 3, other: 1, choices: [{ id: 'c_free', count: 1, percent: 33.3 }, { id: 'c_pro', count: 2, percent: 66.7 }] });
    expect((by('b_plan') as Extract<FormFieldSummary, { kind: 'choice' }>).otherLatest).toMatchObject([{ value: 'Team' }]);
    expect(by('b_rating')).toMatchObject({ kind: 'numeric', answered: 3, average: 4, min: 3, max: 5, distribution: [{ value: 3, count: 1 }, { value: 4, count: 1 }, { value: 5, count: 1 }] });
    expect(by('b_nps')).toMatchObject({ kind: 'nps', answered: 3, promoters: 2, passives: 0, detractors: 1, score: 33 });
    expect((by('b_nps') as Extract<FormFieldSummary, { kind: 'nps' }>).distribution).toHaveLength(11);
    expect(by('b_agree')).toMatchObject({ kind: 'boolean', answered: 2 + 0 + 1, yes: 2, no: 1 });
    expect(by('b_rank')).toMatchObject({ kind: 'ranking', answered: 3, choices: [{ id: 'r_a', averageRank: 1.33 }, { id: 'r_b', averageRank: 1.67 }] });
    const names = by('b_name') as Extract<FormFieldSummary, { kind: 'text' }>;
    expect(names).toMatchObject({ kind: 'text', answered: 3 });
    expect(names.latest.map((l) => l.value)).toEqual(['Cy', 'Bob', 'Ann']);
    expect(by('b_contact')).toMatchObject({ kind: 'text', answered: 0, latest: [] });
  });

  it('limits to a version and a date range, and keeps the latest text to 20', async () => {
    const form = await publishForm();
    for (let i = 0; i < 25; i++) await addResponse(form, { answers: { b_name: `Person ${i}` }, submittedAt: at(2, 8 + (i % 12)) });
    const all = await data<FormResultsSummary>(await results().request(`${FORMS}/${form.id}/summary`));
    expect((all.fields.find((f) => f.blockId === 'b_name') as Extract<FormFieldSummary, { kind: 'text' }>).latest).toHaveLength(20);
    expect(all.totalResponses).toBe(25);
    const none = await data<FormResultsSummary>(await results().request(`${FORMS}/${form.id}/summary?from=${at(9, 0).toISOString()}`));
    expect(none.totalResponses).toBe(0);
    expect(none.averageScore).toBeNull();
  });
});

describe('insights', () => {
  it('reports views from the counters, starts, completions, time, drop-off and sources', async () => {
    const form = await publishForm();
    const counters = countersFor(world.env.FORM_COUNTERS, form.id);
    await counters.recordView('2026-11-02', 'a');
    await counters.recordView('2026-11-02', 'b');
    await counters.recordView('2026-11-03', 'c');
    // In conformance mode Rust keeps the same day counts in the cache (the test's KV): rust/modules/forms/src/counters.rs.
    if (conformanceTarget()) {
      await world.kv.put(`forms:counters:${form.id}:views:2026-11-02`, '2');
      await world.kv.put(`forms:counters:${form.id}:views:2026-11-03`, '1');
    }
    await addResponse(form, { answers: { b_name: 'Ann' }, startedAt: at(2), submittedAt: at(2, 11), durationMs: 60_000, metadata: { source: 'link' } });
    await addResponse(form, { answers: { b_name: 'Bob' }, startedAt: at(3), submittedAt: at(3, 11), durationMs: 120_000, metadata: { source: 'inline' } });
    await addResponse(form, { status: 'in_progress', startedAt: at(3), updatedAt: at(3), lastBlockId: 'b_plan', metadata: { source: 'link' } });
    await addResponse(form, { status: 'in_progress', startedAt: at(3), updatedAt: at(3), lastBlockId: 'b_name' });

    const from = at(1, 0).toISOString();
    const to = at(5, 0).toISOString();
    const insights = await data<FormInsights>(await results().request(`${FORMS}/${form.id}/insights?from=${from}&to=${to}`));
    expect(insights).toMatchObject({ views: 3, starts: 4, completions: 2, completionRate: 0.5, averageDurationMs: 90_000 });
    expect(insights.byDay.find((d) => d.date === '2026-11-02')).toEqual({ date: '2026-11-02', views: 2, starts: 1, completions: 1 });
    expect(insights.byDay.find((d) => d.date === '2026-11-03')).toEqual({ date: '2026-11-03', views: 1, starts: 3, completions: 1 });
    expect(insights.byDay.find((d) => d.date === '2026-11-04')).toEqual({ date: '2026-11-04', views: 0, starts: 0, completions: 0 });
    expect(insights.bySource).toEqual([{ source: 'link', starts: 3, completions: 1 }, { source: 'inline', starts: 1, completions: 1 }]);

    const drop = (id: string) => insights.dropOff.find((d) => d.blockId === id)!;
    expect(drop('b_name')).toMatchObject({ leftHere: 1, reached: 4, dropOffRate: 0.25 });
    expect(drop('b_plan')).toMatchObject({ leftHere: 1, reached: 3 });
    expect(drop('b_rating')).toMatchObject({ leftHere: 0, reached: 2 });
    for (const d of insights.dropOff) expect(d.dropOffRate).toBeGreaterThanOrEqual(0), expect(d.dropOffRate).toBeLessThanOrEqual(1);
  });

  it('has no rate without starts', async () => {
    const form = await publishForm();
    const insights = await data<FormInsights>(await results().request(`${FORMS}/${form.id}/insights`));
    expect(insights).toMatchObject({ views: 0, starts: 0, completions: 0, completionRate: null, averageDurationMs: null });
  });
});

describe('export', () => {
  let form: FormDetail;
  beforeEach(async () => {
    form = await publishForm();
    await addResponse(form, { id: 'frs_e1', respondentEmail: 'ann@example.com', answers: { b_name: 'Ann, "the" Great', b_plan: { choiceIds: ['c_pro'] }, b_contact: { firstName: 'Ann', email: 'ann@acme.nl' } }, score: 5, hidden: { utm_source: 'news' }, searchText: 'ann', submittedAt: at(2), metadata: { source: 'link' } });
    await addResponse(form, { id: 'frs_e2', answers: { b_name: '=SUM(A1)', b_note: 'line1\nline2', b_rating: -3 }, submittedAt: at(3) });
  });

  const get = (format: string, query = '') => results().request(`${FORMS}/${form.id}/responses/export?format=${format}${query}`);

  it('writes RFC 4180 CSV with a byte order mark, quoted fields and defused formulas', async () => {
    const res = await get('csv', '&sort=oldest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Survey-responses-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Number,Submitted,Email,Your name,Private note,Which plan?,Rate us,Recommend us?,Happy?,Contact · First name,Contact · Last name,Contact · Email,Contact · Phone,Contact · Company,Rank these,utm_source,Score,Time taken,Status,Started,Version,Source,Device,Country,Referrer');
    expect(lines[1]).toContain('"Ann, ""the"" Great"');
    expect(lines[1]).toContain('Pro,');
    expect(lines[1]).toContain('ann@acme.nl');
    expect(lines[1]).toContain(',news,5,60,completed,');
    // The formula is defused, the multi-line value quoted, a negative number left alone.
    expect(text).toContain("'=SUM(A1)");
    expect(text).toContain('"line1\nline2"');
    expect(text).toContain(',-3,');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('applies the list filters to the export', async () => {
    const text = await (await get('csv', `&filters=${encodeURIComponent(JSON.stringify([{ blockId: 'b_plan', operator: 'any_of', value: ['c_pro'] }]))}`)).text();
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(2);
    expect(text).not.toContain('SUM(A1)');
  });

  it('writes a minimal XLSX package: workbook, styles and one sheet of inline strings and numbers', async () => {
    const res = await get('xlsx', '&sort=oldest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toContain('.xlsx');
    const zip = openZip(new Uint8Array(await res.arrayBuffer()));
    const names = zip.names();
    expect(names).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']));
    const sheet = (await zip.readText('xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Number</t></is></c>');
    expect(sheet).toContain('Ann, &quot;the&quot; Great');
    expect(sheet).toContain('<c r="A2"><v>');
    expect(sheet).toContain('=SUM(A1)');
  });

  it('refuses an export without the right, or of a format it does not know', async () => {
    expect((await results({ permissions: ['forms:read', 'form_responses:read'] }).request(`${FORMS}/${form.id}/responses/export?format=csv`)).status).toBe(403);
    expect((await get('pdf')).status).toBe(400);
  });
});

describe('deleting', () => {
  it('deletes one response with its files and actions, lowers the count and publishes form_response:deleted', async () => {
    const form = await publishForm();
    const keep = await addResponse(form, { respondentEmail: 'keep@example.com' });
    const id = await addResponse(form, { respondentEmail: 'gone@example.com', personId: 'per_1', invitationId: 'fin_1' });
    await world.privateBucket.put('workspaces/org_forms/weldforms/f/a.pdf', 'bytes');
    await db.insert(schema.formResponseFiles).values({ id: 'ffl_9', responseId: id, formId: form.id, blockId: 'b_name', storageKey: 'workspaces/org_forms/weldforms/f/a.pdf', name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 5 });
    await db.insert(schema.formIntegrations).values({ id: 'fig_1', formId: form.id, kind: 'crm', config: {}, createdByUserId: 'user_owner' });
    await db.insert(schema.formResponseActions).values({ id: 'fra_1', responseId: id, formId: form.id, integrationId: 'fig_1', kind: 'crm', status: 'done' });
    const app = results();

    const res = await app.request(`${FORMS}/${form.id}/responses/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    await app.settled();
    expect((await db.select().from(schema.formResponses)).map((r) => r.id)).toEqual([keep]);
    expect(await db.select().from(schema.formResponseFiles)).toHaveLength(0);
    expect(await db.select().from(schema.formResponseActions)).toHaveLength(0);
    expect(await world.privateBucket.get('workspaces/org_forms/weldforms/f/a.pdf')).toBeNull();
    const [row] = await db.select().from(schema.forms).where(eq(schema.forms.id, form.id));
    expect(row!.responseCount).toBe(1);
    expect(eventNames(world.sent)).toEqual(['form_response:deleted']);
    expect(world.sent[0]!.data).toMatchObject({ id, formId: form.id, formTitle: 'Survey', respondentEmail: 'gone@example.com', personId: 'per_1', invitationId: 'fin_1' });
    expect((await app.request(`${FORMS}/${form.id}/responses/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('deletes several at once, only of this form, one event each', async () => {
    const form = await publishForm();
    const other = await publishForm(simpleDefinition(), 'Other');
    const a = await addResponse(form);
    const b = await addResponse(form);
    const c = await addResponse(form);
    const foreign = await addResponse(other);
    const app = results();
    const res = await app.request(`${FORMS}/${form.id}/responses/bulk-delete`, json({ ids: [a, b, foreign, 'frs_none'] }));
    expect(await data<{ deleted: number }>(res)).toEqual({ deleted: 2 });
    await app.settled();
    expect((await db.select().from(schema.formResponses)).map((r) => r.id).sort()).toEqual([c, foreign].sort());
    expect(eventNames(world.sent)).toEqual(['form_response:deleted', 'form_response:deleted']);
    expect((await app.request(`${FORMS}/${form.id}/responses/bulk-delete`, json({ ids: [] }))).status).toBe(400);
  });

  it('needs form_responses:delete', async () => {
    const form = await publishForm();
    const id = await addResponse(form);
    const app = results({ permissions: ['forms:read', 'form_responses:read'] });
    expect((await app.request(`${FORMS}/${form.id}/responses/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await app.request(`${FORMS}/${form.id}/responses/bulk-delete`, json({ ids: [id] }))).status).toBe(403);
  });

  it('erases every response of one email across forms, with files, and says how many and where', async () => {
    const one = await publishForm(simpleDefinition(), 'One');
    const two = await publishForm(simpleDefinition(), 'Two');
    const a = await addResponse(one, { respondentEmail: 'Ann@Example.com' });
    await addResponse(one, { respondentEmail: 'bob@example.com' });
    const c = await addResponse(two, { respondentEmail: 'ann@example.com' });
    await world.privateBucket.put('k/ann', 'x');
    await db.insert(schema.formResponseFiles).values({ id: 'ffl_a', responseId: c, formId: two.id, blockId: 'b_name', storageKey: 'k/ann', name: 'n', contentType: 'text/plain', sizeBytes: 1 });
    const app = cross();
    const res = await app.request(`${CROSS}/erase`, json({ email: ' ANN@example.com ' }));
    expect(await data<EraseRespondentResult>(res)).toEqual({ responsesDeleted: 2, formsAffected: 2 });
    await app.settled();
    expect((await db.select().from(schema.formResponses)).map((r) => r.respondentEmail)).toEqual(['bob@example.com']);
    expect(await world.privateBucket.get('k/ann')).toBeNull();
    expect(eventNames(world.sent)).toEqual(['form_response:deleted', 'form_response:deleted']);
    expect(a).toBeTruthy();
    expect((await cross({ permissions: ['form_responses:read'] }).request(`${CROSS}/erase`, json({ email: 'x@example.com' }))).status).toBe(403);
    expect((await app.request(`${CROSS}/erase`, json({ email: 'not-an-email' }))).status).toBe(400);
  });

  it('leaves the responses of a restricted form the member is not on', async () => {
    const form = await publishForm();
    await addResponse(form, { respondentEmail: 'ann@example.com' });
    await forms().request(`${FORMS}/${form.id}`, json({ revision: form.revision, access: 'restricted' }, 'PATCH'));
    const res = await cross({ userId: 'user_other', permissions: ['form_responses:delete'] }).request(`${CROSS}/erase`, json({ email: 'ann@example.com' }));
    expect(await data<EraseRespondentResult>(res)).toEqual({ responsesDeleted: 0, formsAffected: 0 });
    expect(await db.select().from(schema.formResponses)).toHaveLength(1);
  });
});

describe('files', () => {
  it('streams an uploaded file from the private bucket as a download, never cached', async () => {
    const form = await publishForm();
    const id = await addResponse(form);
    await world.privateBucket.put('workspaces/org_forms/weldforms/f/cv.pdf', 'PDF-BYTES');
    await db.insert(schema.formResponseFiles).values({ id: 'ffl_cv', responseId: id, formId: form.id, blockId: 'b_name', storageKey: 'workspaces/org_forms/weldforms/f/cv.pdf', name: 'My CV "final".pdf', contentType: 'application/pdf', sizeBytes: 9 });
    const res = await results().request(`${FORMS}/${form.id}/responses/${id}/files/ffl_cv`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PDF-BYTES');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''My%20CV%20%22final%22.pdf");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const detail = await data<FormResponseDetail>(await results().request(`${FORMS}/${form.id}/responses/${id}`));
    expect(detail.files[0]).toMatchObject({ fileId: 'ffl_cv', kind: 'upload', downloadPath: `/api/forms/forms/${form.id}/responses/${id}/files/ffl_cv` });
    expect((await results().request(`${FORMS}/${form.id}/responses/${id}/files/ffl_none`)).status).toBe(404);
    expect((await results({ permissions: ['forms:read'] }).request(`${FORMS}/${form.id}/responses/${id}/files/ffl_cv`)).status).toBe(403);
  });
});

describe('retrying an integration step', () => {
  it('starts a ProcessResponse run for that integration only and shows the action as pending', async () => {
    const form = await publishForm();
    const id = await addResponse(form);
    await db.insert(schema.formIntegrations).values({ id: 'fig_crm', formId: form.id, kind: 'crm', config: {}, createdByUserId: 'user_owner' });
    await db.insert(schema.formResponseActions).values({ id: 'fra_crm', responseId: id, formId: form.id, integrationId: 'fig_crm', kind: 'crm', status: 'failed', error: 'CRM is down', attempts: 2 });

    const res = await results().request(`${FORMS}/${form.id}/responses/${id}/actions/fra_crm/retry`, json({}));
    expect(res.status).toBe(200);
    expect(await data<{ queued: true }>(res)).toEqual({ queued: true });
    expect(world.processed).toHaveLength(1);
    expect(world.processed[0]!.id).toMatch(new RegExp(`^${id}-retry-`));
    expect(world.processed[0]!.params).toMatchObject({ responseId: id, formId: form.id, mode: 'submit', retryIntegrationId: 'fig_crm', clerkOrgId: ORG });
    const [action] = await db.select().from(schema.formResponseActions).where(eq(schema.formResponseActions.id, 'fra_crm'));
    expect(action).toMatchObject({ status: 'pending', error: null });
  });

  it('answers 404 for an unknown action or a removed integration and 409 for a response not completed', async () => {
    const form = await publishForm();
    const id = await addResponse(form);
    const open = await addResponse(form, { status: 'in_progress' });
    await db.insert(schema.formResponseActions).values({ id: 'fra_gone', responseId: id, formId: form.id, integrationId: 'fig_gone', kind: 'crm', status: 'failed' });
    await db.insert(schema.formIntegrations).values({ id: 'fig_open', formId: form.id, kind: 'desk', config: {}, createdByUserId: 'user_owner' });
    await db.insert(schema.formResponseActions).values({ id: 'fra_open', responseId: open, formId: form.id, integrationId: 'fig_open', kind: 'desk', status: 'failed' });
    const retry = (rid: string, aid: string, who?: Parameters<typeof memberApp>[4]) => results(who).request(`${FORMS}/${form.id}/responses/${rid}/actions/${aid}/retry`, json({}));
    expect((await retry(id, 'fra_none')).status).toBe(404);
    expect((await retry(id, 'fra_gone')).status).toBe(404);
    expect((await retry(open, 'fra_open')).status).toBe(409);
    expect((await retry(id, 'fra_gone', { permissions: ['form_responses:read'] })).status).toBe(403);
    expect(world.processed).toHaveLength(0);
  });
});

describe('a person across forms', () => {
  it('lists their responses on the forms the member may read, newest first, with the form title', async () => {
    const one = await publishForm(simpleDefinition(), 'One');
    const two = await publishForm(simpleDefinition(), 'Two');
    const hidden = await publishForm(simpleDefinition(), 'Hidden');
    await addResponse(one, { personId: 'per_ann', submittedAt: at(2) });
    await addResponse(two, { personId: 'per_ann', submittedAt: at(4) });
    await addResponse(two, { personId: 'per_bob', submittedAt: at(5) });
    await addResponse(hidden, { personId: 'per_ann', submittedAt: at(6) });
    await forms().request(`${FORMS}/${hidden.id}`, json({ revision: hidden.revision, access: 'restricted' }, 'PATCH'));

    const res = await cross({ userId: 'user_other', permissions: ['forms:read', 'form_responses:read'] }).request(`${CROSS}/responses?personId=per_ann`);
    const body = await page<PersonFormResponse>(res);
    expect(body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    expect(body.data.map((r) => [r.formTitle, r.personId])).toEqual([['Two', 'per_ann'], ['One', 'per_ann']]);

    const owner = await page<PersonFormResponse>(await cross().request(`${CROSS}/responses?personId=per_ann&limit=1`));
    expect(owner.data.map((r) => r.formTitle)).toEqual(['Hidden']);
    expect(owner.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    expect((await cross().request(`${CROSS}/responses`)).status).toBe(400);
    expect((await cross({ permissions: ['forms:read'] }).request(`${CROSS}/responses?personId=per_ann`)).status).toBe(403);
  });
});
