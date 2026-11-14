/**
 * ProcessResponse: the runner loads the response, runs the registered steps in
 * order, records integration steps in `form_response_actions`, and lets a failing
 * step fail alone. Run on pglite with fake steps (the real integration steps come
 * with the next wave); adding a step is one file in ./steps.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { newWorld, simpleDefinition, type World } from '../test/support';
import { PROCESS_STEPS } from './steps';
import type { ProcessStep } from './steps/types';
import { runProcessResponse, type StepRunner } from './process-response';
import type { ProcessResponseParams } from './process-params';

const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => dbs.tenant, getMasterDb: () => dbs.master };
});

let db: Database;
let world: World;
const params: ProcessResponseParams = { clerkOrgId: 'org_pr', workspaceId: 'ws_pr', formId: 'frm_pr', responseId: 'frs_pr', mode: 'submit' };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  dbs.tenant = db;
}, 120_000);

beforeEach(async () => {
  world = newWorld();
  const t = schema;
  await db.delete(t.formResponseActions);
  await db.delete(t.formResponseFiles);
  await db.delete(t.formResponses);
  await db.delete(t.formIntegrations);
  await db.delete(t.formVersions);
  await db.delete(t.forms);
  await db.insert(t.forms).values({ id: 'frm_pr', title: 'Process', definition: simpleDefinition(), settings: {}, ownerUserId: 'user_owner', publicId: 'pubpubpub1', status: 'published' });
  await db.insert(t.formVersions).values({ id: 'fve_pr', formId: 'frm_pr', number: 1, definition: simpleDefinition(), publishedByUserId: 'user_owner' });
  await db.insert(t.formResponses).values({ id: 'frs_pr', formId: 'frm_pr', versionId: 'fve_pr', number: 1, status: 'completed', answers: { b_name: 'Ada' }, submittedAt: new Date() });
  await db.insert(t.formIntegrations).values([
    { id: 'fig_crm', formId: 'frm_pr', kind: 'crm', config: {}, createdByUserId: 'user_owner' },
    { id: 'fig_desk', formId: 'frm_pr', kind: 'desk', config: {}, createdByUserId: 'user_owner' },
    { id: 'fig_off', formId: 'frm_pr', kind: 'crm', config: {}, enabled: false, createdByUserId: 'user_owner' },
  ]);
});

/** The inline runner with the retries a Workflow would do: each step is tried `attempts` times. */
const runner = (attempts = 1): StepRunner & { names: string[] } => {
  const names: string[] = [];
  return {
    names,
    async do(name, _config, run) {
      names.push(name);
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await run();
        } catch (err) {
          last = err;
        }
      }
      throw last;
    },
  };
};

describe('ProcessResponse', () => {
  it('lists the steps for people after the integrations; without steps the runner only loads the response', async () => {
    expect(PROCESS_STEPS.map((s) => s.name).slice(-3)).toEqual(['notify', 'receipt', 'quota']);
    const r = runner();
    await runProcessResponse(world.env, params, r, []);
    expect(r.names).toEqual(['load response']);
  });

  it('a retry runs only the named integration, not the other integrations or the always-steps', async () => {
    const order: string[] = [];
    const steps: ProcessStep[] = [
      { type: 'integration', kind: 'crm', name: 'crm', run: async (_ctx, integration) => (order.push(`crm:${integration.id}`), { status: 'done' }) },
      { type: 'integration', kind: 'desk', name: 'desk', run: async (_ctx, integration) => (order.push(`desk:${integration.id}`), { status: 'done' }) },
      { type: 'always', name: 'notify', run: async () => void order.push('notify') },
    ];
    const r = runner();
    await runProcessResponse(world.env, { ...params, retryIntegrationId: 'fig_desk' }, r, steps);
    expect(order).toEqual(['desk:fig_desk']);
    expect(r.names).toEqual(['load response', 'desk:fig_desk']);
  });

  it('does nothing for a response that is not completed or does not exist', async () => {
    await db.update(schema.formResponses).set({ status: 'in_progress' }).where(eq(schema.formResponses.id, 'frs_pr'));
    const ran = vi.fn();
    const step: ProcessStep = { type: 'always', name: 'notify', run: async () => void ran() };
    await runProcessResponse(world.env, params, runner(), [step]);
    await runProcessResponse(world.env, { ...params, responseId: 'frs_missing' }, runner(), [step]);
    expect(ran).not.toHaveBeenCalled();
  });

  it('runs integration steps once per enabled integration of their kind, in order, and records each', async () => {
    const order: string[] = [];
    const steps: ProcessStep[] = [
      { type: 'integration', kind: 'crm', name: 'crm', run: async (ctx, integration) => (order.push(`crm:${integration.id}`), { status: 'done', entityType: 'person', entityId: 'per_1' }) },
      { type: 'integration', kind: 'desk', name: 'desk', run: async (_ctx, integration) => (order.push(`desk:${integration.id}`), { status: 'skipped', reason: 'The member lost the permission' }) },
      { type: 'always', name: 'notify', run: async (ctx) => void order.push(`notify:${ctx.response.number}:${ctx.definition.endings[0]!.id}`) },
    ];
    const r = runner();
    await runProcessResponse(world.env, params, r, steps);
    expect(order).toEqual(['crm:fig_crm', 'desk:fig_desk', 'notify:1:e_done']);
    expect(r.names).toEqual(['load response', 'crm:fig_crm', 'desk:fig_desk', 'notify']);

    const actions = await db.select().from(schema.formResponseActions).orderBy(schema.formResponseActions.integrationId);
    expect(actions.map((a) => [a.integrationId, a.kind, a.status, a.entityType, a.entityId, a.error, a.attempts])).toEqual([
      ['fig_crm', 'crm', 'done', 'person', 'per_1', null, 1],
      ['fig_desk', 'desk', 'skipped', null, null, 'The member lost the permission', 1],
    ]);
    const [desk] = await db.select().from(schema.formIntegrations).where(eq(schema.formIntegrations.id, 'fig_desk'));
    expect(desk!.lastError).toBe('The member lost the permission');
    const [crm] = await db.select().from(schema.formIntegrations).where(eq(schema.formIntegrations.id, 'fig_crm'));
    expect(crm!.lastError).toBeNull();
  });

  it('retries a failing step on its own, records the failure and still runs the other steps', async () => {
    let crmCalls = 0;
    const notify = vi.fn(async () => undefined);
    const steps: ProcessStep[] = [
      { type: 'integration', kind: 'crm', name: 'crm', run: async () => { crmCalls++; throw new Error('CRM is down'); } },
      { type: 'always', name: 'notify', run: notify },
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runProcessResponse(world.env, params, runner(3), steps);
    error.mockRestore();
    expect(crmCalls).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
    const [action] = await db.select().from(schema.formResponseActions).where(eq(schema.formResponseActions.integrationId, 'fig_crm'));
    expect(action).toMatchObject({ status: 'failed', error: 'CRM is down', attempts: 3 });
    const [integration] = await db.select().from(schema.formIntegrations).where(eq(schema.formIntegrations.id, 'fig_crm'));
    expect(integration!.lastError).toBe('CRM is down');
  });

  it('a retry that succeeds replaces the failure and does not repeat the steps before it', async () => {
    let tries = 0;
    const before = vi.fn(async () => undefined);
    const steps: ProcessStep[] = [
      { type: 'always', name: 'first', run: before },
      { type: 'integration', kind: 'crm', name: 'crm', run: async () => { if (++tries < 2) throw new Error('flaky'); return { status: 'done', entityType: 'person', entityId: 'per_2' }; } },
    ];
    await runProcessResponse(world.env, params, runner(3), steps);
    expect(before).toHaveBeenCalledTimes(1);
    const [action] = await db.select().from(schema.formResponseActions).where(eq(schema.formResponseActions.integrationId, 'fig_crm'));
    expect(action).toMatchObject({ status: 'done', entityId: 'per_2', error: null, attempts: 2 });
  });
});
