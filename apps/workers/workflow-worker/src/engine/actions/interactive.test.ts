import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleManualStep, handleSendChoices, handleCollectInput } from './interactive';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

describe('manual_step (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  it('creates a notification and parks the run waiting for input', async () => {
    const ctx = makeActionContext({ db, tenant: { workspaceId: 'ws_test', userId: 'reviewer' } });
    const res = (await handleManualStep({ title: 'Approve refund' }, ctx)) as {
      __waitingForInput: boolean;
      stepType: string;
    };
    expect(res.__waitingForInput).toBe(true);
    expect(res.stepType).toBe('manual_step');

    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, 'reviewer'));
    expect(rows.some((r) => r.notificationType === 'manual_step' && r.title === 'Approve refund')).toBe(true);
  });
});

describe('interactive actions without a conversation', () => {
  it('send_choices / collect_input return success:false when no conversation can be resolved', async () => {
    const ctx = makeActionContext();
    expect(await handleSendChoices({ message: 'pick' }, ctx)).toMatchObject({ success: false });
    expect(await handleCollectInput({ message: 'fill' }, ctx)).toMatchObject({ success: false });
  });
});
