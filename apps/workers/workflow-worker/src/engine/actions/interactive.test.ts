import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleManualStep,
  handleSendChoices,
  handleCollectInput,
  manualStepApproverIds,
  manualStepDecision,
  type ManualStepWaiting,
} from './interactive';
import { NonRetryableStepError } from '../errors';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

describe('manual_step (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    for (const userId of ['reviewer', 'approver_1', 'approver_2', 'wf_owner']) {
      await db.insert(schema.workspaceMembers).values({ id: `wm_ms_${userId}`, userId });
    }
  });

  const notificationsFor = (userId: string) =>
    db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));

  it('notifies the listed approvers with a link to the run and parks the run waiting for input', async () => {
    const ctx = makeActionContext({
      db,
      executionId: 'wex_approval_1',
      tenant: { workspaceId: 'ws_test', userId: 'reviewer' },
      triggerData: { workflowName: 'Refunds' },
    });
    const res = (await handleManualStep(
      { title: 'Approve refund', approverIds: ['approver_1', 'approver_2', 'not_a_member', ''] },
      ctx,
    )) as ManualStepWaiting;

    expect(res).toMatchObject({
      __waitingForInput: true,
      stepType: 'manual_step',
      title: 'Approve refund',
      description: null,
      approverIds: ['approver_1', 'approver_2'],
      notifiedUserIds: ['approver_1', 'approver_2'],
    });
    const [row] = await notificationsFor('approver_1');
    expect(row).toMatchObject({
      notificationType: 'manual_step',
      title: 'Approve refund',
      body: '"Refunds" is waiting for your approval.',
      actionUrl: '/weldconnect/executions/wex_approval_1',
      entityType: 'workflow_execution',
      entityId: 'wex_approval_1',
    });
    expect(await notificationsFor('not_a_member')).toHaveLength(0);
  });

  it('notifies the workflow owner when no approver is listed', async () => {
    const ctx = makeActionContext({ db, tenant: { workspaceId: 'ws_test', userId: 'system', ownerUserId: 'wf_owner' } });
    const res = (await handleManualStep({ title: 'Check it', description: 'Look at the order' }, ctx)) as ManualStepWaiting;
    expect(res).toMatchObject({ approverIds: [], notifiedUserIds: ['wf_owner'], description: 'Look at the order' });
    expect((await notificationsFor('wf_owner')).some((r) => r.body === 'Look at the order')).toBe(true);
  });

  it('still reads the legacy single assignee', async () => {
    expect(manualStepApproverIds({ assignTo: 'specific_user', assigneeId: 'reviewer' })).toEqual(['reviewer']);
    expect(manualStepApproverIds({ assignTo: 'trigger_user', assigneeId: 'reviewer' })).toEqual([]);
  });

  it('fails without retrying when none of the approvers is a member', async () => {
    const ctx = makeActionContext({ db });
    await expect(handleManualStep({ approverIds: ['ghost'] }, ctx)).rejects.toBeInstanceOf(NonRetryableStepError);
  });
});

describe('manualStepDecision', () => {
  it('normalises the resume payload', () => {
    expect(manualStepDecision({ approved: true, comment: '  ok ', decidedBy: 'u1', decidedAt: '2026-10-06T10:00:00Z' })).toEqual({
      approved: true,
      decision: 'approved',
      comment: 'ok',
      decidedBy: 'u1',
      decidedByName: null,
      decidedAt: '2026-10-06T10:00:00Z',
    });
    expect(manualStepDecision({ decision: 'rejected', comment: '' })).toMatchObject({ approved: false, decision: 'rejected', comment: null });
    expect(manualStepDecision({})).toMatchObject({ approved: false, decision: 'rejected' });
  });
});

describe('interactive actions without a conversation', () => {
  it('send_choices / collect_input return success:false when no conversation can be resolved', async () => {
    const ctx = makeActionContext();
    expect(await handleSendChoices({ message: 'pick' }, ctx)).toMatchObject({ success: false });
    expect(await handleCollectInput({ message: 'fill' }, ctx)).toMatchObject({ success: false });
  });
});
