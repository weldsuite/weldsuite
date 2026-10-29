import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveInternalWorkspaceId: vi.fn(),
  meterUsage: vi.fn(),
}));
vi.mock('@weldsuite/credits', () => ({ resolveInternalWorkspaceId: mocks.resolveInternalWorkspaceId }));
vi.mock('@weldsuite/credits/meters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/credits/meters')>()),
  meterUsage: mocks.meterUsage,
}));
vi.mock('../db', () => ({ getMasterDb: () => ({}) }));

import { meterRun } from './meter-run';
import type { WorkflowEnv } from '../engine/types';

const env = { DATABASE_URL_MASTER: 'postgres://master', USAGE_METER: {} } as WorkflowEnv;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveInternalWorkspaceId.mockResolvedValue('ws_1');
});

describe('meterRun', () => {
  it('lets the run go ahead when the meter allows it, counting it for the workspace', async () => {
    mocks.meterUsage.mockResolvedValue({ allowed: true, reservation: null, used: 1, allowance: 500, creditsCharged: 0 });

    expect(await meterRun(env, 'org_1', 'wex_1', 'user_1')).toBeNull();
    expect(mocks.meterUsage).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws_1',
      meter: 'workflow_runs',
      idempotencyKey: 'run:wex_1',
      referenceId: 'wex_1',
      referenceType: 'workflow_execution',
      userId: 'user_1',
    });
  });

  it('says why when the plan stops at its allowance', async () => {
    mocks.meterUsage.mockResolvedValue({
      allowed: false,
      reason: 'limit_reached',
      meter: 'workflow_runs',
      used: 500,
      allowance: 500,
      planName: 'Free',
    });

    expect(await meterRun(env, 'org_1', 'wex_1', 'user_1')).toBe(
      'Your Free plan includes 500 workflow runs per month and they are used up. Upgrade your plan to continue.',
    );
  });

  it('runs unmetered without a master DB, a meter binding, a known workspace or a working meter', async () => {
    expect(await meterRun({ USAGE_METER: {} } as WorkflowEnv, 'org_1', 'wex_1', 'user_1')).toBeNull();
    expect(await meterRun({ DATABASE_URL_MASTER: 'postgres://master' } as WorkflowEnv, 'org_1', 'wex_1', 'user_1')).toBeNull();

    mocks.resolveInternalWorkspaceId.mockResolvedValueOnce(null);
    expect(await meterRun(env, 'org_1', 'wex_1', 'user_1')).toBeNull();

    mocks.meterUsage.mockRejectedValueOnce(new Error('down'));
    expect(await meterRun(env, 'org_1', 'wex_1', 'user_1')).toBeNull();
  });
});
