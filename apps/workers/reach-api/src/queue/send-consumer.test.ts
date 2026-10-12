import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { Database } from '@weldsuite/worker-kit';
import { reachEnrollments } from '@weldsuite/db/schema';

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), counter: 0 }));
const tenant = vi.hoisted(() => ({ readReachAccess: vi.fn(), openTenantDb: vi.fn() }));
vi.mock('../lib/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tenant')>()),
  readReachAccess: (...args: unknown[]) => tenant.readReachAccess(...args),
  openTenantDb: (...args: unknown[]) => tenant.openTenantDb(...args),
}));
vi.mock('@weldsuite/smtp', () => ({
  buildMimeMessage: (message: unknown) => JSON.stringify(message),
  generateMessageId: (domain: string) => `msg${++smtp.counter}@${domain}`,
  sendMail: (...args: unknown[]) => smtp.sendMail(...args),
}));

import { handleSendQueue, isSendingEnabled, processSendMessage } from './send-consumer';
import type { Env, ReachSendMessage } from '../types';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect, seedSettings, testEnv } from '../test-support/reach';

const MIGRATION = readFileSync(resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');

const T0 = new Date('2026-10-12T10:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ORG = 'org_test';

const access = (overrides: Partial<AppAccess> = {}): AppAccess => ({
  workspaceId: 'ws_1',
  status: 'approved',
  limits: {},
  billingStatus: 'active',
  billingStatusAt: null,
  ...overrides,
});

let db: Database;
let d1: D1Database;
let env: ReturnType<typeof testEnv>;

const dueAt = () =>
  d1
    .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_send' AND workspace_id = ?")
    .bind(ORG)
    .first<number>('next_due_at');

const run = (overrides: { access?: AppAccess; openDb?: () => Promise<Database> } = {}) => {
  const openDb = vi.fn(overrides.openDb ?? (async () => db));
  const readAccess = vi.fn(async () => overrides.access ?? access());
  return processSendMessage(env, { clerkOrgId: ORG, enqueuedAt: T0.getTime() }, { openDb, readAccess, now: () => T0 }).then((outcome) => ({
    outcome,
    openDb,
    readAccess,
  }));
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  await seedSettings(db);
  d1 = createSqliteD1(MIGRATION);
  env = testEnv({ SCHEDULE_INDEX: d1, WORKSPACE_CACHE: createMemoryKv() });
  smtp.sendMail.mockReset();
  smtp.sendMail.mockResolvedValue({ ok: true, response: '250 OK', accepted: ['x'] });
  await markWorkspaceDue(d1, 'reach_send', ORG, T0.getTime() + 10 * MINUTE); // what the sweep leaves behind
});

describe('processSendMessage: who may send', () => {
  it.each([
    ['requested', { status: 'requested' as const }],
    ['suspended', { status: 'suspended' as const }],
    ['revoked', { status: 'revoked' as const }],
    ['canceled billing', { billingStatus: 'canceled' as const }],
    ['past due beyond the grace', { billingStatus: 'past_due' as const, billingStatusAt: new Date(T0.getTime() - 8 * 24 * HOUR).toISOString() }],
  ])('sends nothing and does not open the tenant when access is %s', async (_label, patch) => {
    const { outcome, openDb } = await run({ access: access(patch) });
    expect(outcome.status).toBe('skipped');
    expect(openDb).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
    // looked at again in an hour, in case the suspension is lifted
    expect(await dueAt()).toBe(T0.getTime() + HOUR);
  });

  it('still sends while a past-due subscription is inside its grace period', async () => {
    const { outcome } = await run({
      access: access({ billingStatus: 'past_due', billingStatusAt: new Date(T0.getTime() - 2 * 24 * HOUR).toISOString() }),
    });
    expect(outcome.status).toBe('ticked');
  });

  it('drops a workspace that no longer exists', async () => {
    const { outcome, openDb } = await run({ access: access({ workspaceId: null, status: 'none' }) });
    expect(outcome).toEqual({ status: 'skipped', reason: 'unknown_workspace' });
    expect(openDb).not.toHaveBeenCalled();
    expect(await dueAt()).toBeNull();
  });
});

describe('processSendMessage: kill switch', () => {
  it('sends nothing while the Flagship flag is off, and checks again in five minutes', async () => {
    env = testEnv({
      SCHEDULE_INDEX: d1,
      WORKSPACE_CACHE: createMemoryKv(),
      FLAGSHIP: { getBooleanValue: async (key: string) => key !== 'weldreach-sending' } as unknown as Env['FLAGSHIP'],
    });
    const { outcome, openDb } = await run();
    expect(outcome).toEqual({ status: 'skipped', reason: 'kill_switch' });
    expect(openDb).not.toHaveBeenCalled();
    expect(await dueAt()).toBe(T0.getTime() + 5 * MINUTE);
  });

  it('is on when Flagship is not bound, and follows the flag when it is', async () => {
    expect(await isSendingEnabled(env, ORG)).toBe(true);
    const calls: Array<[string, boolean, unknown]> = [];
    const flagged = {
      ...env,
      FLAGSHIP: {
        getBooleanValue: async (key: string, fallback: boolean, context: unknown) => {
          calls.push([key, fallback, context]);
          return true;
        },
      },
    } as unknown as Env;
    expect(await isSendingEnabled(flagged, ORG)).toBe(true);
    expect(calls[0]?.[0]).toBe('weldreach-sending');
    expect(calls[0]?.[1]).toBe(true);
    expect(calls[0]?.[2]).toMatchObject({ workspaceId: ORG });
  });
});

describe('processSendMessage: a tick', () => {
  it('sends what is due and stores when the workspace next has work', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'One', body: 'B' }, { subject: 'Two', body: 'B2', delayDays: 2 }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);

    const { outcome, openDb } = await run();

    expect(openDb).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('ticked');
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    // the provisional time (+10 min) is replaced by the follow-up's
    expect(await dueAt()).toBe(T0.getTime() + 2 * 24 * HOUR);
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row?.currentStep).toBe(1);
  });

  it('drops the due row once nothing is left to send', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    await run();
    expect(await dueAt()).toBeNull();
  });

  it('keeps a launch that happened during the tick', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    const earlier = T0.getTime() + MINUTE;
    const outcome = await processSendMessage(
      env,
      { clerkOrgId: ORG, enqueuedAt: T0.getTime() },
      {
        readAccess: async () => {
          await markWorkspaceDue(d1, 'reach_send', ORG, earlier); // another request pulls the workspace forward
          return access();
        },
        openDb: async () => db,
        now: () => T0,
      },
    );
    expect(outcome.status).toBe('ticked');
    expect(await dueAt()).toBe(earlier);
  });
});

describe('handleSendQueue', () => {
  const message = (orgId: string) => ({
    body: { clerkOrgId: orgId, enqueuedAt: T0.getTime() } satisfies ReachSendMessage,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it('acks what it handled and retries what threw, without losing the rest of the batch', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    tenant.readReachAccess.mockImplementation(async (_env: unknown, org: string) => {
      if (org === 'org_broken') throw new Error('master database unavailable');
      return access();
    });
    tenant.openTenantDb.mockResolvedValue(db);
    const good = message(ORG);
    const bad = message('org_broken');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleSendQueue({ messages: [bad, good] } as never, env, {} as ExecutionContext);

    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(bad.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalled();
    expect(good.retry).not.toHaveBeenCalled();
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
