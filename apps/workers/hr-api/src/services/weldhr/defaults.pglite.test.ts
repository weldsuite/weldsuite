/**
 * Default seeding: the first requests on a fresh workspace arrive together
 * (the mobile app fires about six at once), and every one of them runs the
 * seeders before the per-isolate memo is set. They must still leave exactly
 * one set of templates, leave types, scorecard and KPIs.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ensureDefaultTemplates } from './lifecycle';
import { ensureDefaultEvaluationForm, ensureDefaultKpis } from './performance';
import { ensureDefaultLeaveTypes } from './time';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.hrChecklistTemplates);
  await db.delete(schema.hrLeaveTypes);
  await db.delete(schema.hrEvaluationForms);
  await db.delete(schema.hrKpiDefinitions);
});

/** What `ensureHrDefaults` runs per request. */
function seedAll(database: Database) {
  return Promise.all([
    ensureDefaultTemplates(database),
    ensureDefaultLeaveTypes(database),
    ensureDefaultEvaluationForm(database),
    ensureDefaultKpis(database),
  ]);
}

async function names() {
  const [templates, leaveTypes, forms, kpis] = await Promise.all([
    db.select({ name: schema.hrChecklistTemplates.name }).from(schema.hrChecklistTemplates),
    db.select({ name: schema.hrLeaveTypes.name }).from(schema.hrLeaveTypes),
    db.select({ name: schema.hrEvaluationForms.name }).from(schema.hrEvaluationForms),
    db.select({ name: schema.hrKpiDefinitions.name }).from(schema.hrKpiDefinitions),
  ]);
  const sorted = (rows: { name: string }[]) => rows.map((r) => r.name).sort();
  return { templates: sorted(templates), leaveTypes: sorted(leaveTypes), forms: sorted(forms), kpis: sorted(kpis) };
}

const ONE_SET = {
  templates: ['Standard offboarding', 'Standard onboarding'],
  leaveTypes: ['Annual leave', 'Sick leave', 'Unpaid leave'],
  forms: ['Quality scorecard'],
  kpis: ['Average handle time', 'CSAT', 'First contact resolution', 'Quality score'],
};

describe('ensureHrDefaults seeders', () => {
  it('seed one set when six first requests race on a fresh workspace', async () => {
    await Promise.all(Array.from({ length: 6 }, () => seedAll(db)));
    expect(await names()).toEqual(ONE_SET);
  });

  it('leave a workspace alone once it has its own rows', async () => {
    await db.insert(schema.hrLeaveTypes).values({ id: 'hrlvt_own', name: 'Parental leave' });
    await seedAll(db);
    expect((await names()).leaveTypes).toEqual(['Parental leave']);
  });
});
