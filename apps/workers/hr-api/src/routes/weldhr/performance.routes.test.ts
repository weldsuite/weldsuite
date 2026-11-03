/**
 * Route tests for WeldHR performance: /coaching, /evaluation-forms,
 * /evaluations, /kpis, /kpi-values and /milestones, against a real pglite
 * tenant database through the whole /api/weldhr router.
 *
 * These are the requests the Rust port (rust/modules/hr) is compared on in
 * conformance mode, refusals included.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  HR_ADMIN,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedCompany,
  seedEmployee,
  seedMember,
  today,
} from '../../test/hr-fixtures';

let db: Database;

const FORM_CRITERIA = [
  { id: 'q', label: 'Quality', weight: 1, maxScore: 5 },
  { id: 's', label: 'Speed', weight: 2, maxScore: 10 },
  { id: 'n', label: 'Notes', weight: 0, maxScore: 5 },
];

beforeAll(async () => {
  db = await hrDb();
  // Seed the starter scorecard and KPIs before any test adds its own: the
  // first request only seeds an empty table.
  await hrCaller(db).get('/kpis');
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_cora', { name: 'Cora Coach', email: 'cora@example.com' });
  await seedMember(db, 'user_ann', { name: 'Ann Agent', email: 'ann@example.com' });
  await seedCompany(db, 'co_acme', 'Acme');
  await seedEmployee(db, { id: 'hremp_ann', userId: 'user_ann', email: 'ann@example.com', firstName: 'Ann', lastName: 'Agent', employeeNumber: 'E-001' });
  await seedEmployee(db, { id: 'hremp_bo', email: 'bo@example.com', firstName: 'Bo', lastName: 'Berg', employeeNumber: 'E-002' });
  await db.insert(schema.hrEvaluationForms).values({
    id: 'hrevf_f1',
    name: 'Agent review',
    criteria: FORM_CRITERIA,
    createdAt: new Date('2026-01-05T09:00:00.000Z'),
    updatedAt: new Date('2026-01-05T09:00:00.000Z'),
  });
  await db.insert(schema.hrKpiDefinitions).values([
    { id: 'hrkpi_k1', name: 'Calls handled', unit: 'number', direction: 'higher_better', target: 50 },
    { id: 'hrkpi_k2', name: 'Acme NPS', unit: 'number', direction: 'higher_better', target: null, companyId: 'co_acme' },
    { id: 'hrkpi_k3', name: 'Retired metric', unit: 'number', isActive: false },
  ]);
});

const admin = () => hrCaller(db);
const as = (...grants: string[]) => hrCaller(db, { grants });

const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

describe('/coaching', () => {
  beforeEach(async () => {
    await db.insert(schema.hrCoachingLogs).values([
      {
        id: 'hrcch_c1',
        employeeId: 'hremp_ann',
        companyId: 'co_acme',
        coachUserId: 'user_cora',
        sessionDate: '2026-01-10',
        category: 'quality',
        topic: 'Call wrap-up',
        followUpDate: daysFromToday(-1),
        createdAt: at('2026-01-10T10:00:00.000Z'),
      },
      {
        id: 'hrcch_c2',
        employeeId: 'hremp_bo',
        coachName: 'External coach',
        sessionDate: '2026-01-12',
        topic: 'Tone',
        status: 'closed',
        visibility: 'internal',
        followUpDate: daysFromToday(-1),
        createdAt: at('2026-01-12T10:00:00.000Z'),
      },
      {
        id: 'hrcch_gone',
        employeeId: 'hremp_ann',
        sessionDate: '2026-01-11',
        topic: 'Removed',
        deletedAt: at('2026-01-13T10:00:00.000Z'),
      },
    ]);
  });

  it('lists logs by session date with the coach and client named, and filters them', async () => {
    const res = await admin().get('/coaching');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; coachName: string | null; companyName: string | null; employeeName: string }>>(res);
    expect(rows.map((r) => [r.id, r.employeeName, r.coachName, r.companyName])).toEqual([
      ['hrcch_c2', 'Bo Berg', 'External coach', null],
      ['hrcch_c1', 'Ann Agent', 'Cora Coach', 'Acme'],
    ]);

    const ids = async (query: string) => (await data<Array<{ id: string }>>(await admin().get(`/coaching${query}`))).map((r) => r.id);
    expect(await ids('?employeeId=hremp_ann')).toEqual(['hrcch_c1']);
    expect(await ids('?companyId=co_acme')).toEqual(['hrcch_c1']);
    expect(await ids('?status=closed,acknowledged')).toEqual(['hrcch_c2']);
    expect(await ids('?category=quality')).toEqual(['hrcch_c1']);
    expect(await ids('?from=2026-01-11&to=2026-01-31')).toEqual(['hrcch_c2']);
    expect(await ids('?followUpDue=true')).toEqual(['hrcch_c1']);
    expect((await as('evaluations:read').get('/coaching')).status).toBe(403);
  });

  it('answers one log as stored', async () => {
    const res = await admin().get('/coaching/hrcch_c1');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrcch_c1', coachUserId: 'user_cora', coachName: null, actionItems: [], status: 'open', visibility: 'employee' });
    expect((await admin().get('/coaching/hrcch_gone')).status).toBe(404);
    expect((await admin().get('/coaching/hrcch_nope')).status).toBe(404);
    expect((await as('evaluations:read').get('/coaching/hrcch_c1')).status).toBe(403);
  });

  it('logs a session, naming the coach after the workspace member', async () => {
    const own = await admin().send('POST', '/coaching', { employeeId: 'hremp_ann', sessionDate: '2026-01-20', topic: 'First week' });
    expect(own.status).toBe(201);
    expect(await data(own)).toMatchObject({
      employeeId: 'hremp_ann',
      coachUserId: HR_ADMIN,
      coachName: 'Hanna Admin',
      category: 'performance',
      status: 'open',
      visibility: 'employee',
      actionItems: [],
      followUpDate: null,
      acknowledgedAt: null,
    });

    const byCora = await admin().send('POST', '/coaching', {
      employeeId: 'hremp_bo',
      coachUserId: 'user_cora',
      sessionDate: '2026-01-21',
      category: 'development',
      topic: 'Escalations',
      notes: 'Went well',
      actionItems: [{ id: 'a1', text: 'Shadow a senior', done: false }],
      followUpDate: '2026-02-04',
      visibility: 'internal',
    });
    expect(byCora.status).toBe(201);
    expect(await data(byCora)).toMatchObject({
      coachUserId: 'user_cora',
      coachName: 'Cora Coach',
      category: 'development',
      actionItems: [{ id: 'a1', text: 'Shadow a senior', done: false }],
      visibility: 'internal',
    });

    const named = await admin().send('POST', '/coaching', { employeeId: 'hremp_bo', coachName: 'Guest trainer', sessionDate: '2026-01-22', topic: 'Product' });
    expect((await data<{ coachName: string }>(named)).coachName).toBe('Guest trainer');
  });

  it('refuses a follow-up before the session, an unknown employee, bad input and a caller without coaching:create', async () => {
    const early = await admin().send('POST', '/coaching', { employeeId: 'hremp_ann', sessionDate: '2026-01-20', followUpDate: '2026-01-19', topic: 'X' });
    expect(early.status).toBe(400);
    expect((await errorOf(early)).message).toBe('The follow-up date cannot be before the session date');
    expect((await admin().send('POST', '/coaching', { employeeId: 'hremp_nope', sessionDate: '2026-01-20', topic: 'X' })).status).toBe(404);
    const invalid = await admin().send('POST', '/coaching', { employeeId: 'hremp_ann', sessionDate: '2026-01-20', category: 'mood', topic: '' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Category must be one of performance, quality, behavior, attendance, development, recognition. Topic is required',
    );
    expect((await as('coaching:read').send('POST', '/coaching', { employeeId: 'hremp_ann', sessionDate: '2026-01-20', topic: 'X' })).status).toBe(403);
  });

  it('updates a log and checks the follow-up against the stored session date', async () => {
    const res = await admin().send('PATCH', '/coaching/hrcch_c1', {
      status: 'closed',
      notes: 'Resolved',
      actionItems: [{ id: 'a1', text: 'Use the checklist', done: true }],
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrcch_c1', status: 'closed', notes: 'Resolved', actionItems: [{ id: 'a1', text: 'Use the checklist', done: true }] });

    const early = await admin().send('PATCH', '/coaching/hrcch_c1', { followUpDate: '2026-01-09' });
    expect(early.status).toBe(400);
    expect((await errorOf(early)).message).toBe('The follow-up date cannot be before the session date');
    const invalid = await admin().send('PATCH', '/coaching/hrcch_c1', { actionItems: [{ id: 'a1', text: '', done: false }] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Action items #1 text is required');
    expect((await admin().send('PATCH', '/coaching/hrcch_gone', { notes: 'x' })).status).toBe(404);
    expect((await as('coaching:create').send('PATCH', '/coaching/hrcch_c1', { notes: 'x' })).status).toBe(403);
  });

  it('deletes a log softly', async () => {
    expect((await as('coaching:update').send('DELETE', '/coaching/hrcch_c1')).status).toBe(403);
    expect((await admin().send('DELETE', '/coaching/hrcch_c1')).status).toBe(204);
    expect((await admin().get('/coaching/hrcch_c1')).status).toBe(404);
    expect((await admin().send('DELETE', '/coaching/hrcch_c1')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Evaluation forms
// ---------------------------------------------------------------------------

describe('/evaluation-forms', () => {
  beforeEach(async () => {
    await db.insert(schema.hrEvaluationForms).values([
      { id: 'hrevf_f2', name: 'Old form', criteria: [{ id: 'x', label: 'X', weight: 1, maxScore: 5 }], isActive: false },
      { id: 'hrevf_gone', name: 'Removed form', criteria: [], deletedAt: at('2026-01-06T00:00:00.000Z') },
    ]);
  });

  it('lists forms by name, the inactive ones unless asked for active only', async () => {
    const res = await admin().get('/evaluation-forms');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; criteria: unknown[] }>>(res);
    expect(rows.map((r) => r.id)).toEqual(['hrevf_f1', 'hrevf_f2', 'hrevf_default_scorecard']);
    expect(rows[0]!.criteria).toEqual(FORM_CRITERIA);
    const active = await data<Array<{ id: string }>>(await admin().get('/evaluation-forms?activeOnly=true'));
    expect(active.map((r) => r.id)).toEqual(['hrevf_f1', 'hrevf_default_scorecard']);
    expect((await as('coaching:read').get('/evaluation-forms')).status).toBe(403);
  });

  it('creates a form and refuses duplicate criteria and a form that weighs nothing', async () => {
    const res = await admin().send('POST', '/evaluation-forms', {
      name: 'Team lead review',
      description: 'Twice a year',
      criteria: [{ id: 'lead', label: 'Leadership', description: 'Guides the team', weight: 3, maxScore: 4 }],
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      name: 'Team lead review',
      description: 'Twice a year',
      isActive: true,
      criteria: [{ id: 'lead', label: 'Leadership', description: 'Guides the team', weight: 3, maxScore: 4 }],
    });

    const dupe = await admin().send('POST', '/evaluation-forms', {
      name: 'Dupe',
      criteria: [
        { id: 'q', label: 'A', weight: 1, maxScore: 5 },
        { id: 'q', label: 'B', weight: 1, maxScore: 5 },
      ],
    });
    expect(dupe.status).toBe(400);
    expect((await errorOf(dupe)).message).toBe('Duplicate criterion id "q"');
    const weightless = await admin().send('POST', '/evaluation-forms', { name: 'Zero', criteria: [{ id: 'q', label: 'A', weight: 0, maxScore: 5 }] });
    expect(weightless.status).toBe(400);
    expect((await errorOf(weightless)).message).toBe('At least one criterion needs a weight above zero');
    const invalid = await admin().send('POST', '/evaluation-forms', { name: 'Empty', criteria: [] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Criteria needs at least 1 item(s)');
    expect((await as('evaluations:create').send('POST', '/evaluation-forms', { name: 'X', criteria: FORM_CRITERIA })).status).toBe(403);
  });

  it('updates and deletes a form', async () => {
    const res = await admin().send('PATCH', '/evaluation-forms/hrevf_f2', { name: 'Older form', isActive: true });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrevf_f2', name: 'Older form', isActive: true });
    const dupe = await admin().send('PATCH', '/evaluation-forms/hrevf_f2', {
      criteria: [
        { id: 'x', label: 'A', weight: 1, maxScore: 5 },
        { id: 'x', label: 'B', weight: 1, maxScore: 5 },
      ],
    });
    expect(dupe.status).toBe(400);
    expect((await admin().send('PATCH', '/evaluation-forms/hrevf_gone', { name: 'X' })).status).toBe(404);
    expect((await as('evaluations:update').send('PATCH', '/evaluation-forms/hrevf_f2', { name: 'X' })).status).toBe(403);

    expect((await as('evaluations:delete').send('DELETE', '/evaluation-forms/hrevf_f2')).status).toBe(403);
    expect((await admin().send('DELETE', '/evaluation-forms/hrevf_f2')).status).toBe(204);
    const rows = await data<Array<{ id: string }>>(await admin().get('/evaluation-forms'));
    expect(rows.map((r) => r.id)).not.toContain('hrevf_f2');
    expect((await admin().send('DELETE', '/evaluation-forms/hrevf_f2')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

describe('/evaluations', () => {
  beforeEach(async () => {
    await db.insert(schema.hrEvaluations).values([
      {
        id: 'hrevl_e1',
        employeeId: 'hremp_ann',
        formId: 'hrevf_f1',
        companyId: 'co_acme',
        evaluatorUserId: 'user_cora',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        criteria: FORM_CRITERIA,
        scores: [
          { criterionId: 'q', score: 4 },
          { criterionId: 's', score: 8 },
        ],
        overallScore: 80,
        status: 'submitted',
        submittedAt: at('2026-02-01T10:00:00.000Z'),
        createdAt: at('2026-02-01T09:00:00.000Z'),
      },
      {
        id: 'hrevl_e2',
        employeeId: 'hremp_bo',
        formId: 'hrevf_default_scorecard',
        evaluatorName: 'Outside reviewer',
        criteria: FORM_CRITERIA,
        status: 'draft',
        createdAt: at('2026-02-03T09:00:00.000Z'),
      },
      {
        id: 'hrevl_e3',
        employeeId: 'hremp_ann',
        formId: 'hrevf_f1',
        criteria: FORM_CRITERIA,
        scores: [{ criterionId: 'q', score: 5 }],
        overallScore: 100,
        status: 'acknowledged',
        acknowledgedAt: at('2026-01-20T10:00:00.000Z'),
        createdAt: at('2026-01-15T09:00:00.000Z'),
      },
      { id: 'hrevl_gone', employeeId: 'hremp_ann', formId: 'hrevf_f1', status: 'draft', deletedAt: at('2026-02-04T00:00:00.000Z') },
    ]);
  });

  it('lists evaluations newest first with names, and filters them', async () => {
    const res = await admin().get('/evaluations');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; employeeName: string; formName: string | null; evaluatorName: string | null; companyName: string | null }>>(res);
    expect(rows.map((r) => [r.id, r.employeeName, r.formName, r.evaluatorName, r.companyName])).toEqual([
      ['hrevl_e2', 'Bo Berg', 'Quality scorecard', 'Outside reviewer', null],
      ['hrevl_e1', 'Ann Agent', 'Agent review', 'Cora Coach', 'Acme'],
      ['hrevl_e3', 'Ann Agent', 'Agent review', null, null],
    ]);

    const ids = async (query: string) => (await data<Array<{ id: string }>>(await admin().get(`/evaluations${query}`))).map((r) => r.id);
    expect(await ids('?employeeId=hremp_ann&status=submitted,acknowledged')).toEqual(['hrevl_e1', 'hrevl_e3']);
    expect(await ids('?formId=hrevf_default_scorecard')).toEqual(['hrevl_e2']);
    expect(await ids('?companyId=co_acme')).toEqual(['hrevl_e1']);
    // The period, or the day it was created when it has none.
    expect(await ids('?from=2026-02-01')).toEqual(['hrevl_e2']);
    expect(await ids('?to=2026-01-15')).toEqual(['hrevl_e1', 'hrevl_e3']);
    expect((await as('coaching:read').get('/evaluations')).status).toBe(403);
  });

  it('answers one evaluation as stored', async () => {
    const res = await admin().get('/evaluations/hrevl_e1');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrevl_e1', evaluatorName: null, overallScore: 80, status: 'submitted' });
    expect((await admin().get('/evaluations/hrevl_gone')).status).toBe(404);
    expect((await as('coaching:read').get('/evaluations/hrevl_e1')).status).toBe(403);
  });

  it('saves a draft with the form’s criteria and a weighted overall score, or submits it', async () => {
    const draft = await admin().send('POST', '/evaluations', {
      employeeId: 'hremp_ann',
      formId: 'hrevf_f1',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      scores: [
        { criterionId: 'q', score: 4 },
        { criterionId: 's', score: 7, comment: 'Quick' },
      ],
      summary: 'Solid month',
    });
    expect(draft.status).toBe(201);
    expect(await data(draft)).toMatchObject({
      employeeId: 'hremp_ann',
      formId: 'hrevf_f1',
      companyId: null,
      evaluatorUserId: HR_ADMIN,
      evaluatorName: 'Hanna Admin',
      criteria: FORM_CRITERIA,
      overallScore: 73.3,
      status: 'draft',
      submittedAt: null,
      sharedWithClient: false,
    });

    const submitted = await admin().send('POST', '/evaluations', {
      employeeId: 'hremp_bo',
      formId: 'hrevf_f1',
      scores: [
        { criterionId: 'q', score: 5 },
        { criterionId: 's', score: 10 },
      ],
      submit: true,
    });
    expect(submitted.status).toBe(201);
    const body = await data<{ status: string; submittedAt: string | null; overallScore: number }>(submitted);
    expect(body).toMatchObject({ status: 'submitted', overallScore: 100 });
    expect(body.submittedAt).not.toBeNull();

    const empty = await admin().send('POST', '/evaluations', { employeeId: 'hremp_bo', formId: 'hrevf_f1' });
    expect((await data<{ overallScore: number | null; scores: unknown[] }>(empty))).toMatchObject({ overallScore: null, scores: [] });
  });

  it('refuses incomplete submissions, unknown or over-scored criteria, bad periods and unknown records', async () => {
    const send = (body: Record<string, unknown>) => admin().send('POST', '/evaluations', { employeeId: 'hremp_ann', formId: 'hrevf_f1', ...body });
    const missing = await send({ scores: [{ criterionId: 'q', score: 3 }], submit: true });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Score every criterion before submitting. Missing: Speed');
    const future = await send({ scores: [{ criterionId: 'q', score: 3 }, { criterionId: 's', score: 3 }], periodStart: daysFromToday(5), submit: true });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe(
      'An evaluation period that has not started yet cannot be submitted; save it as a draft',
    );
    const unknown = await send({ scores: [{ criterionId: 'z', score: 1 }] });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toBe('Unknown criterion "z"');
    const over = await send({ scores: [{ criterionId: 'q', score: 6 }] });
    expect(over.status).toBe(400);
    expect((await errorOf(over)).message).toBe('"Quality" is scored out of 5');
    const period = await send({ periodStart: '2026-02-01', periodEnd: '2026-01-01' });
    expect(period.status).toBe(400);
    expect((await errorOf(period)).message).toBe('Evaluation period: end date is before start date');
    expect((await send({ employeeId: 'hremp_nope' })).status).toBe(404);
    expect((await send({ formId: 'hrevf_gone' })).status).toBe(404);
    const invalid = await admin().send('POST', '/evaluations', { employeeId: 'hremp_ann', scores: [{ criterionId: 'q', score: 101 }] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Form id is required. Scores #1 score must be at most 100');
    expect((await as('evaluations:read').send('POST', '/evaluations', { employeeId: 'hremp_ann', formId: 'hrevf_f1' })).status).toBe(403);
  });

  it('rescores and submits a draft, and keeps an acknowledged one as it is', async () => {
    const rescored = await admin().send('PATCH', '/evaluations/hrevl_e2', {
      scores: [
        { criterionId: 'q', score: 2 },
        { criterionId: 's', score: 5 },
      ],
      companyId: 'co_acme',
    });
    expect(rescored.status).toBe(200);
    expect(await data(rescored)).toMatchObject({ id: 'hrevl_e2', overallScore: 46.7, status: 'draft', companyId: 'co_acme' });

    const missing = await admin().send('PATCH', '/evaluations/hrevl_e2', { scores: [{ criterionId: 'q', score: 2 }], submit: true });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Score every criterion before submitting. Missing: Speed');

    const submitted = await admin().send('PATCH', '/evaluations/hrevl_e2', { submit: true, summary: 'Ready' });
    expect(submitted.status).toBe(200);
    const body = await data<{ status: string; submittedAt: string | null; summary: string }>(submitted);
    expect(body).toMatchObject({ status: 'submitted', summary: 'Ready' });
    expect(body.submittedAt).not.toBeNull();

    const locked = await admin().send('PATCH', '/evaluations/hrevl_e3', { scores: [{ criterionId: 'q', score: 1 }] });
    expect(locked.status).toBe(409);
    expect((await errorOf(locked)).message).toBe('An acknowledged evaluation can no longer be rescored');
    const shared = await admin().send('PATCH', '/evaluations/hrevl_e3', { sharedWithClient: true });
    expect(shared.status).toBe(200);
    expect(await data(shared)).toMatchObject({ sharedWithClient: true, status: 'acknowledged', overallScore: 100 });

    expect((await admin().send('PATCH', '/evaluations/hrevl_e2', { scores: [{ criterionId: 'z', score: 1 }] })).status).toBe(400);
    expect((await admin().send('PATCH', '/evaluations/hrevl_gone', { summary: 'x' })).status).toBe(404);
    expect((await as('evaluations:create').send('PATCH', '/evaluations/hrevl_e2', { summary: 'x' })).status).toBe(403);
  });

  it('deletes an evaluation softly', async () => {
    expect((await as('evaluations:update').send('DELETE', '/evaluations/hrevl_e2')).status).toBe(403);
    expect((await admin().send('DELETE', '/evaluations/hrevl_e2')).status).toBe(204);
    expect((await admin().get('/evaluations/hrevl_e2')).status).toBe(404);
    expect((await admin().send('DELETE', '/evaluations/hrevl_e2')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

describe('/kpis', () => {
  it('lists the active KPIs with their client, narrowed to a client and with the inactive ones on request', async () => {
    const res = await admin().get('/kpis');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; companyName: string | null }>>(res);
    expect(rows.map((r) => r.id).sort()).toEqual([
      'hrkpi_default_aht',
      'hrkpi_default_csat',
      'hrkpi_default_fcr',
      'hrkpi_default_quality',
      'hrkpi_k1',
      'hrkpi_k2',
    ]);
    expect(rows[0]).toMatchObject({ id: 'hrkpi_k2', companyName: 'Acme' });

    const forBeta = await data<Array<{ id: string }>>(await admin().get('/kpis?companyId=co_beta'));
    expect(forBeta.map((r) => r.id)).not.toContain('hrkpi_k2');
    const forAcme = await data<Array<{ id: string }>>(await admin().get('/kpis?companyId=co_acme'));
    expect(forAcme.map((r) => r.id)).toContain('hrkpi_k2');
    const all = await data<Array<{ id: string }>>(await admin().get('/kpis?includeInactive=true'));
    expect(all.map((r) => r.id)).toContain('hrkpi_k3');
    expect((await as('coaching:read').get('/kpis')).status).toBe(403);
  });

  it('creates a KPI and refuses a negative target for a percentage or a duration', async () => {
    const res = await admin().send('POST', '/kpis', { name: 'Net balance', target: -5 });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ name: 'Net balance', unit: 'number', direction: 'higher_better', target: -5, companyId: null, isActive: true });

    const percent = await admin().send('POST', '/kpis', { name: 'Uptime', unit: 'percent', target: -1 });
    expect(percent.status).toBe(400);
    expect((await errorOf(percent)).message).toBe('The target of a percentage or duration KPI cannot be negative');
    const invalid = await admin().send('POST', '/kpis', { name: 'Hours', unit: 'hours', direction: 'up' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Unit must be one of number, percent, seconds, minutes, currency. Direction must be one of higher_better, lower_better',
    );
    expect((await as('evaluations:create').send('POST', '/kpis', { name: 'X' })).status).toBe(403);
  });

  it('updates a KPI, checking the target against the unit it ends up with', async () => {
    const res = await admin().send('PATCH', '/kpis/hrkpi_k1', { target: 60, direction: 'lower_better' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrkpi_k1', target: 60, direction: 'lower_better', unit: 'number' });

    await db.insert(schema.hrKpiDefinitions).values({ id: 'hrkpi_neg', name: 'Balance', unit: 'number', target: -5 });
    const minutes = await admin().send('PATCH', '/kpis/hrkpi_neg', { unit: 'minutes' });
    expect(minutes.status).toBe(400);
    expect((await errorOf(minutes)).message).toBe('The target of a percentage or duration KPI cannot be negative');
    const nope = await admin().send('PATCH', '/kpis/hrkpi_nope', { name: 'X' });
    expect(nope.status).toBe(404);
    expect((await errorOf(nope)).code).toBe('NOT_FOUND');
    expect((await as('evaluations:update').send('PATCH', '/kpis/hrkpi_k1', { name: 'X' })).status).toBe(403);
  });

  it('archives a KPI with values and deletes one without', async () => {
    await db.insert(schema.hrKpiValues).values({ id: 'hrkpv_x1', kpiId: 'hrkpi_k1', employeeId: 'hremp_ann', periodStart: '2026-01-01', periodEnd: '2026-01-31', value: 40 });
    const archived = await admin().send('DELETE', '/kpis/hrkpi_k1');
    expect(archived.status).toBe(200);
    expect(await data(archived)).toEqual({ archived: true });
    const [k1] = await db.select().from(schema.hrKpiDefinitions).where(eq(schema.hrKpiDefinitions.id, 'hrkpi_k1'));
    expect(k1!.isActive).toBe(false);

    const deleted = await admin().send('DELETE', '/kpis/hrkpi_k2');
    expect(await data(deleted)).toEqual({ archived: false });
    expect(await db.select().from(schema.hrKpiDefinitions).where(eq(schema.hrKpiDefinitions.id, 'hrkpi_k2'))).toHaveLength(0);
    expect((await admin().send('DELETE', '/kpis/hrkpi_k2')).status).toBe(404);
    expect((await as('evaluations:delete').send('DELETE', '/kpis/hrkpi_k3')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// KPI values
// ---------------------------------------------------------------------------

describe('/kpi-values', () => {
  beforeEach(async () => {
    await db.insert(schema.hrKpiValues).values([
      { id: 'hrkpv_v1', kpiId: 'hrkpi_k1', employeeId: 'hremp_ann', companyId: 'co_acme', periodStart: '2026-01-01', periodEnd: '2026-01-31', value: 55 },
      { id: 'hrkpv_v2', kpiId: 'hrkpi_default_aht', employeeId: 'hremp_ann', periodStart: '2026-01-01', periodEnd: '2026-01-31', value: 400 },
      { id: 'hrkpv_v3', kpiId: 'hrkpi_k1', employeeId: 'hremp_bo', periodStart: '2025-12-01', periodEnd: '2025-12-31', value: 40 },
      { id: 'hrkpv_v4', kpiId: 'hrkpi_k2', employeeId: 'hremp_bo', periodStart: '2026-02-01', periodEnd: '2026-02-28', value: 30 },
    ]);
  });

  it('lists values newest period first with the KPI and whether it is on target, and filters them', async () => {
    const res = await admin().get('/kpi-values');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; kpiName: string; employeeName: string; onTarget: boolean | null; target: number | null }>>(res);
    expect(rows.map((r) => [r.id, r.kpiName, r.employeeName, r.onTarget])).toEqual([
      ['hrkpv_v4', 'Acme NPS', 'Bo Berg', null],
      ['hrkpv_v2', 'Average handle time', 'Ann Agent', false],
      ['hrkpv_v1', 'Calls handled', 'Ann Agent', true],
      ['hrkpv_v3', 'Calls handled', 'Bo Berg', false],
    ]);
    expect(rows[1]).toMatchObject({ unit: 'seconds', direction: 'lower_better', target: 360 });

    const ids = async (query: string) => (await data<Array<{ id: string }>>(await admin().get(`/kpi-values${query}`))).map((r) => r.id);
    expect(await ids('?employeeId=hremp_bo')).toEqual(['hrkpv_v4', 'hrkpv_v3']);
    expect(await ids('?kpiId=hrkpi_k1')).toEqual(['hrkpv_v1', 'hrkpv_v3']);
    expect(await ids('?companyId=co_acme')).toEqual(['hrkpv_v1']);
    expect(await ids('?from=2026-01-15&to=2026-01-31')).toEqual(['hrkpv_v2', 'hrkpv_v1']);
    expect(await ids('?to=2025-12-31')).toEqual(['hrkpv_v3']);
    expect((await as('coaching:read').get('/kpi-values')).status).toBe(403);
  });

  it('records a value and refuses a bad period, an unknown KPI or employee and bad input', async () => {
    const res = await admin().send('POST', '/kpi-values', { kpiId: 'hrkpi_k1', employeeId: 'hremp_bo', periodStart: '2026-01-01', periodEnd: '2026-01-31', value: 42.5 });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      kpiId: 'hrkpi_k1',
      employeeId: 'hremp_bo',
      companyId: null,
      value: 42.5,
      source: 'manual',
      sharedWithClient: false,
      createdBy: HR_ADMIN,
    });

    const base = { kpiId: 'hrkpi_k1', employeeId: 'hremp_bo', periodStart: '2026-01-01', periodEnd: '2026-01-31', value: 1 };
    const period = await admin().send('POST', '/kpi-values', { ...base, periodEnd: '2025-12-31' });
    expect(period.status).toBe(400);
    expect((await errorOf(period)).message).toBe('KPI period: end date is before start date');
    expect((await admin().send('POST', '/kpi-values', { ...base, kpiId: 'hrkpi_nope' })).status).toBe(404);
    expect((await admin().send('POST', '/kpi-values', { ...base, employeeId: 'hremp_nope' })).status).toBe(404);
    const invalid = await admin().send('POST', '/kpi-values', { kpiId: 'hrkpi_k1', employeeId: 'hremp_bo', periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Value is required');
    expect((await as('evaluations:read').send('POST', '/kpi-values', base)).status).toBe(403);
  });

  it('imports values by email or employee number, updating the period’s value when there is one', async () => {
    const res = await admin().send('POST', '/kpi-values/import', {
      kpiId: 'hrkpi_k1',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      sharedWithClient: true,
      rows: [
        { employee: 'ANN@example.com', value: 61 },
        { employee: ' E-002 ', value: 33, companyId: 'co_acme' },
        { employee: 'nobody@example.com', value: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ created: 1, updated: 1, errors: [{ row: 3, reason: 'No employee matches "nobody@example.com"' }] });
    const [v1] = await db.select().from(schema.hrKpiValues).where(eq(schema.hrKpiValues.id, 'hrkpv_v1'));
    // A re-import replaces the company too: the row gave none.
    expect(v1).toMatchObject({ value: 61, source: 'import', sharedWithClient: true, companyId: null });
    const bo = await db.select().from(schema.hrKpiValues).where(eq(schema.hrKpiValues.employeeId, 'hremp_bo'));
    expect(bo.find((v) => v.periodStart === '2026-01-01')).toMatchObject({ value: 33, companyId: 'co_acme', source: 'import', createdBy: HR_ADMIN });

    const unknown = await admin().send('POST', '/kpi-values/import', { kpiId: 'hrkpi_nope', periodStart: '2026-01-01', periodEnd: '2026-01-31', rows: [{ employee: 'E-001', value: 1 }] });
    expect(unknown.status).toBe(404);
    const period = await admin().send('POST', '/kpi-values/import', { kpiId: 'hrkpi_k1', periodStart: '2026-02-01', periodEnd: '2026-01-31', rows: [{ employee: 'E-001', value: 1 }] });
    expect(period.status).toBe(400);
    const invalid = await admin().send('POST', '/kpi-values/import', { kpiId: 'hrkpi_k1', periodStart: '2026-01-01', periodEnd: '2026-01-31', rows: [] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Rows needs at least 1 item(s)');
    expect((await as('evaluations:update').send('POST', '/kpi-values/import', { kpiId: 'hrkpi_k1', periodStart: '2026-01-01', periodEnd: '2026-01-31', rows: [{ employee: 'E-001', value: 1 }] })).status).toBe(403);
  });

  it('updates and deletes a value', async () => {
    const res = await admin().send('PATCH', '/kpi-values/hrkpv_v1', { value: 70, sharedWithClient: true, periodEnd: '2026-01-30' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrkpv_v1', value: 70, sharedWithClient: true, periodEnd: '2026-01-30', companyId: 'co_acme' });
    const period = await admin().send('PATCH', '/kpi-values/hrkpv_v1', { periodStart: '2026-02-15' });
    expect(period.status).toBe(400);
    expect((await errorOf(period)).message).toBe('KPI period: end date is before start date');
    expect((await admin().send('PATCH', '/kpi-values/hrkpv_nope', { value: 1 })).status).toBe(404);
    expect((await as('evaluations:create').send('PATCH', '/kpi-values/hrkpv_v1', { value: 1 })).status).toBe(403);

    expect((await as('evaluations:update').send('DELETE', '/kpi-values/hrkpv_v1')).status).toBe(403);
    expect((await admin().send('DELETE', '/kpi-values/hrkpv_v1')).status).toBe(204);
    expect(await db.select().from(schema.hrKpiValues).where(eq(schema.hrKpiValues.id, 'hrkpv_v1'))).toHaveLength(0);
    expect((await admin().send('DELETE', '/kpi-values/hrkpv_v1')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

describe('/milestones', () => {
  beforeEach(async () => {
    await db.insert(schema.hrMilestones).values([
      { id: 'hrmil_m1', employeeId: 'hremp_ann', companyId: 'co_acme', title: 'Product certified', dueDate: '2026-03-01', createdAt: at('2026-01-05T09:00:00.000Z') },
      { id: 'hrmil_m2', employeeId: 'hremp_bo', title: 'First month', status: 'achieved', achievedAt: '2026-01-02', createdAt: at('2026-01-05T10:00:00.000Z') },
      { id: 'hrmil_m3', employeeId: 'hremp_ann', title: 'Handle 100 calls', type: 'goal', status: 'in_progress', dueDate: '2026-02-01', createdAt: at('2026-01-05T11:00:00.000Z') },
      { id: 'hrmil_gone', employeeId: 'hremp_ann', title: 'Removed', deletedAt: at('2026-01-06T00:00:00.000Z') },
    ]);
  });

  it('lists milestones by due date, undated last, and filters them', async () => {
    const res = await admin().get('/milestones');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; employeeName: string; companyName: string | null }>>(res);
    expect(rows.map((r) => [r.id, r.employeeName, r.companyName])).toEqual([
      ['hrmil_m3', 'Ann Agent', null],
      ['hrmil_m1', 'Ann Agent', 'Acme'],
      ['hrmil_m2', 'Bo Berg', null],
    ]);
    const ids = async (query: string) => (await data<Array<{ id: string }>>(await admin().get(`/milestones${query}`))).map((r) => r.id);
    expect(await ids('?employeeId=hremp_bo')).toEqual(['hrmil_m2']);
    expect(await ids('?companyId=co_acme')).toEqual(['hrmil_m1']);
    expect(await ids('?status=planned,in_progress')).toEqual(['hrmil_m3', 'hrmil_m1']);
    expect((await as('coaching:read').get('/milestones')).status).toBe(403);
  });

  it('creates milestones, dating an achieved one today and marking a dated one achieved', async () => {
    const planned = await admin().send('POST', '/milestones', { employeeId: 'hremp_ann', title: 'Learn the CRM', dueDate: '2026-04-01' });
    expect(planned.status).toBe(201);
    expect(await data(planned)).toMatchObject({ title: 'Learn the CRM', type: 'milestone', status: 'planned', achievedAt: null, sharedWithClient: false, createdBy: HR_ADMIN });

    const achieved = await admin().send('POST', '/milestones', { employeeId: 'hremp_ann', title: 'Certified', type: 'certification', status: 'achieved' });
    expect(await data(achieved)).toMatchObject({ status: 'achieved', achievedAt: today(), type: 'certification' });

    const dated = await admin().send('POST', '/milestones', { employeeId: 'hremp_bo', title: 'Q1 goal', achievedAt: '2026-01-20', companyId: 'co_acme' });
    expect(await data(dated)).toMatchObject({ status: 'achieved', achievedAt: '2026-01-20', companyId: 'co_acme' });
  });

  it('refuses a missed milestone with an achieved date, an unknown employee and bad input', async () => {
    const missed = await admin().send('POST', '/milestones', { employeeId: 'hremp_ann', title: 'X', status: 'missed', achievedAt: '2026-01-20' });
    expect(missed.status).toBe(400);
    expect((await errorOf(missed)).message).toBe('A missed milestone cannot have an achieved date');
    expect((await admin().send('POST', '/milestones', { employeeId: 'hremp_nope', title: 'X' })).status).toBe(404);
    const invalid = await admin().send('POST', '/milestones', { employeeId: 'hremp_ann', title: '', type: 'dream' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Title is required. Type must be one of goal, milestone, certification');
    expect((await as('evaluations:read').send('POST', '/milestones', { employeeId: 'hremp_ann', title: 'X' })).status).toBe(403);
  });

  it('keeps status and achieved date in step on update', async () => {
    const achieved = await admin().send('PATCH', '/milestones/hrmil_m1', { status: 'achieved' });
    expect(achieved.status).toBe(200);
    expect(await data(achieved)).toMatchObject({ id: 'hrmil_m1', status: 'achieved', achievedAt: today() });

    const reopened = await admin().send('PATCH', '/milestones/hrmil_m2', { status: 'planned' });
    expect(await data(reopened)).toMatchObject({ status: 'planned', achievedAt: null });

    const dated = await admin().send('PATCH', '/milestones/hrmil_m3', { achievedAt: '2026-01-25' });
    expect(await data(dated)).toMatchObject({ status: 'achieved', achievedAt: '2026-01-25' });

    const missed = await admin().send('PATCH', '/milestones/hrmil_m3', { status: 'missed' });
    expect(await data(missed)).toMatchObject({ status: 'missed', achievedAt: null });

    const contradiction = await admin().send('PATCH', '/milestones/hrmil_m3', { status: 'missed', achievedAt: '2026-01-25' });
    expect(contradiction.status).toBe(400);
    expect((await errorOf(contradiction)).message).toBe('A missed milestone cannot have an achieved date');
    expect((await admin().send('PATCH', '/milestones/hrmil_gone', { title: 'X' })).status).toBe(404);
    expect((await as('evaluations:create').send('PATCH', '/milestones/hrmil_m1', { title: 'X' })).status).toBe(403);
  });

  it('deletes a milestone softly', async () => {
    expect((await as('evaluations:update').send('DELETE', '/milestones/hrmil_m1')).status).toBe(403);
    expect((await admin().send('DELETE', '/milestones/hrmil_m1')).status).toBe(204);
    const rows = await data<Array<{ id: string }>>(await admin().get('/milestones'));
    expect(rows.map((r) => r.id)).toEqual(['hrmil_m3', 'hrmil_m2']);
    expect((await admin().send('DELETE', '/milestones/hrmil_m1')).status).toBe(404);
  });
});
