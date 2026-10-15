/**
 * Prospect operations an API runs, against pglite: create, edit, delete and the
 * imports, with the validation verdicts, the list hand-offs and the events.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachEnrollments, reachProspectListMembers, reachProspects } from '@weldsuite/db/schema';
import { ReachDomainError } from './errors';
import type { ReachEvent } from './events';
import { createProspectList, getProspectList } from './lists';
import {
  createProspect,
  deleteProspect,
  getProspect,
  importProspectRows,
  importProspectsFromCrmList,
  importProspectsFromWeldDataList,
  listProspects,
  MAX_IMPORT_EVENTS,
  updateProspect,
  type ProspectDeps,
} from './prospects';
import { resetReach, seedCampaign, seedEnrollment, seedProspect } from './testing/reach';

let db: Database;
let events: ReachEvent[];

const deps = (allowConsumerRecipients = false): ProspectDeps => ({
  db,
  emit: (event) => {
    events.push(event);
  },
  userId: 'user_1',
  limits: { allowConsumerRecipients },
  // No network: every domain can receive mail.
  mxLookup: async () => true,
});

const actions = (type: string) => events.filter((e) => e.entityType === type).map((e) => e.action);

async function refused(promise: Promise<unknown>): Promise<ReachDomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReachDomainError);
  return err as ReachDomainError;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  events = [];
});

describe('createProspect', () => {
  it('stores a validated prospect, publishes reach_prospect:created and can put it on a list', async () => {
    const list = await createProspectList(db, { name: 'Warm' }, 'user_1');

    const prospect = await createProspect(deps(), { email: 'jane@bigco.io', firstName: ' Jane ', listId: list.id });

    expect(prospect).toMatchObject({ email: 'jane@bigco.io', firstName: 'Jane', validation: 'valid', source: 'manual', companyDomain: 'bigco.io' });
    expect(events).toMatchObject([{ entityType: 'reach_prospect', action: 'created', entityId: prospect.id }]);
    expect((await getProspectList(db, list.id)).prospectCount).toBe(1);
  });

  it('judges the address: consumer unless the workspace allows it, role and no-MX addresses are kept with their verdict', async () => {
    expect((await createProspect(deps(), { email: 'jane@gmail.com' })).validation).toBe('consumer');
    expect((await createProspect(deps(true), { email: 'joe@gmail.com' })).validation).toBe('valid');
    expect((await createProspect(deps(), { email: 'info@bigco.io' })).validation).toBe('role');
    expect((await createProspect({ ...deps(), mxLookup: async () => false }, { email: 'a@nomx.example' })).validation).toBe('no_mx');
  });

  it('refuses a duplicate with 409 and a list that does not exist with 404, and an address that is not one with 400', async () => {
    await createProspect(deps(), { email: 'jane@bigco.io' });
    expect(await refused(createProspect(deps(), { email: 'jane@bigco.io' }))).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'A prospect with this email already exists',
    });
    expect(await refused(createProspect(deps(), { email: 'joe@bigco.io', listId: 'rpl_ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "List with ID 'rpl_ghost' not found",
    });
    expect(await refused(createProspect(deps(), { email: 'not-an-address' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The email address is not valid',
    });
  });
});

describe('reading', () => {
  it('lists with filters and a cursor and reads one', async () => {
    const a = await seedProspect(db, { email: 'a@bigco.io', firstName: 'Ann' });
    await seedProspect(db, { email: 'b@bigco.io', firstName: 'Bob', validation: 'role' });
    await seedProspect(db, { email: 'gone@bigco.io', deletedAt: new Date() });

    const page = await listProspects(db, { limit: '1' });
    expect(page).toMatchObject({ totalCount: 2, hasMore: true });
    expect((await listProspects(db, { validation: 'role' })).data.map((p) => p.email)).toEqual(['b@bigco.io']);
    expect((await listProspects(db, { search: 'ann' })).data.map((p) => p.email)).toEqual(['a@bigco.io']);
    expect(await refused(listProspects(db, { validation: 'maybe' }))).toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown validation filter' });

    expect(await getProspect(db, a.id)).toMatchObject({ email: 'a@bigco.io' });
    expect(await refused(getProspect(db, 'rpro_nope'))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('updateProspect and deleteProspect', () => {
  it('edits fields (blank clears them), publishes updated and 404s an unknown id', async () => {
    const p = await seedProspect(db, { firstName: 'Jane', title: 'CTO' });

    const updated = await updateProspect(deps(), p.id, { firstName: '  ', title: 'CEO', customFields: { city: 'Utrecht' } });

    expect(updated).toMatchObject({ firstName: null, title: 'CEO', customFields: { city: 'Utrecht' } });
    expect(actions('reach_prospect')).toEqual(['updated']);
    expect(await refused(updateProspect(deps(), 'rpro_nope', { title: 'x' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('soft-deletes, stops its enrollments, completes the campaign that ran out and publishes both events', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const p = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, p.id);

    await deleteProspect(deps(), p.id);

    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: 'failed', stoppedReason: 'prospect_deleted' });
    expect(events.map((e) => `${e.entityType}:${e.action}`)).toEqual(['reach_campaign:completed', 'reach_prospect:deleted']);
    expect(await refused(deleteProspect(deps(), p.id))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('importProspectRows', () => {
  it('creates, updates and reports what it skipped, onto a new list', async () => {
    await seedProspect(db, { email: 'old@bigco.io', firstName: null });

    const report = await importProspectRows(deps(), {
      rows: [
        { email: 'old@bigco.io', firstName: 'Olga' },
        { email: 'new@bigco.io' },
        { email: 'NEW@bigco.io' },
        { email: 'nonsense' },
        { email: 'info@bigco.io' },
      ],
      listName: 'October import',
      sourceRef: 'oct.csv',
    });

    expect(report).toMatchObject({ created: 2, updated: 1 });
    expect(report.skipped).toEqual(expect.arrayContaining([{ reason: 'duplicate', count: 1 }, { reason: 'invalid_row', count: 1 }, { reason: 'role', count: 1 }]));
    expect(report.listId).toMatch(/^rpl_/);
    expect(await db.select().from(reachProspectListMembers).where(eq(reachProspectListMembers.listId, report.listId as string))).toHaveLength(3);
    const [old] = await db.select().from(reachProspects).where(eq(reachProspects.email, 'old@bigco.io'));
    expect(old?.firstName).toBe('Olga');
    // Two new prospects, so two creation events; the update is silent.
    expect(actions('reach_prospect')).toEqual(['created', 'created']);
  });

  it('publishes creation events for the first MAX_IMPORT_EVENTS new prospects only', async () => {
    const rows = Array.from({ length: MAX_IMPORT_EVENTS + 5 }, (_, i) => ({ email: `p${i}@bigco${i % 7}.io` }));

    const report = await importProspectRows(deps(), { rows });

    expect(report.created).toBe(MAX_IMPORT_EVENTS + 5);
    expect(actions('reach_prospect')).toHaveLength(MAX_IMPORT_EVENTS);
  });

  it('adds to an existing list and 404s one that does not exist', async () => {
    const list = await createProspectList(db, { name: 'Existing' }, 'user_1');

    const report = await importProspectRows(deps(), { rows: [{ email: 'x@bigco.io' }], listId: list.id });
    expect(report.listId).toBe(list.id);
    expect((await getProspectList(db, list.id)).prospectCount).toBe(1);

    expect(await refused(importProspectRows(deps(), { rows: [{ email: 'y@bigco.io' }], listId: 'rpl_ghost' }))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('imports from CRM and WeldData lists', () => {
  it('404s a list that does not exist', async () => {
    expect(await refused(importProspectsFromCrmList(deps(), { crmListId: 'list_ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "CRM list with ID 'list_ghost' not found",
    });
    expect(await refused(importProspectsFromWeldDataList(deps(), { welddataListId: 'wdl_ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "WeldData list with ID 'wdl_ghost' not found",
    });
  });
});
