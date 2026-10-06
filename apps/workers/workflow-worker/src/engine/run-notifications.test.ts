import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { notificationRecipient, notifyRunFinished, wantsNotification } from './run-notifications';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

describe('wantsNotification', () => {
  it('notifies on failure unless notifyOnError is explicitly off', () => {
    expect(wantsNotification(undefined, false)).toBe(true);
    expect(wantsNotification(null, false)).toBe(true);
    expect(wantsNotification({}, false)).toBe(true);
    expect(wantsNotification({ notifyOnError: true }, false)).toBe(true);
    expect(wantsNotification({ notifyOnError: false }, false)).toBe(false);
  });

  it('notifies on success only when notifyOnComplete is explicitly on', () => {
    expect(wantsNotification(undefined, true)).toBe(false);
    expect(wantsNotification({ notifyOnError: true }, true)).toBe(false);
    expect(wantsNotification({ notifyOnComplete: false }, true)).toBe(false);
    expect(wantsNotification({ notifyOnComplete: true }, true)).toBe(true);
  });
});

describe('notificationRecipient', () => {
  it('prefers the owner, then the triggering user, never the system pseudo-user', () => {
    expect(notificationRecipient('owner', 'someone')).toBe('owner');
    expect(notificationRecipient(null, 'someone')).toBe('someone');
    expect(notificationRecipient('', 'someone')).toBe('someone');
    expect(notificationRecipient(null, 'system')).toBeNull();
    expect(notificationRecipient(undefined, undefined)).toBeNull();
  });
});

describe('notifyRunFinished (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  const base = {
    workspaceId: 'ws_1',
    executionId: 'wex_notif',
    workflowName: 'Welcome email',
    createdBy: 'user_owner',
    triggeredBy: 'system',
  };

  it('writes an in-app notification for a failed run, links the execution and pushes it live', async () => {
    const notify = vi.fn(async () => undefined);
    const id = await notifyRunFinished({
      ...base,
      db,
      rt: { notify },
      settings: { notifyOnError: true },
      succeeded: false,
      errorMessage: 'Recipient address "x" is not valid',
    });

    expect(id).toMatch(/^notif_/);
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id!));
    expect(row?.userId).toBe('user_owner');
    expect(row?.title).toBe('Workflow failed: Welcome email');
    expect(row?.body).toBe('Recipient address "x" is not valid');
    expect(row?.notificationType).toBe('workflow_failed');
    expect(row?.severity).toBe('error');
    expect(row?.actionUrl).toBe('/weldconnect/executions/wex_notif');
    expect(row?.entityId).toBe('wex_notif');
    expect(notify).toHaveBeenCalledWith('ws_1', 'user_owner', expect.objectContaining({ id, severity: 'error' }));
  });

  it('notifies a failure by default when the workflow has no settings', async () => {
    const id = await notifyRunFinished({ ...base, db, rt: null, settings: null, succeeded: false });
    expect(id).not.toBeNull();
  });

  it('stays silent when notifyOnError is off, and for a success without notifyOnComplete', async () => {
    expect(await notifyRunFinished({ ...base, db, rt: null, settings: { notifyOnError: false }, succeeded: false })).toBeNull();
    expect(await notifyRunFinished({ ...base, db, rt: null, settings: {}, succeeded: true })).toBeNull();
  });

  it('notifies a completed run when notifyOnComplete is on, falling back to the triggering user', async () => {
    const id = await notifyRunFinished({
      ...base,
      createdBy: null,
      triggeredBy: 'user_runner',
      db,
      rt: null,
      settings: { notifyOnComplete: true },
      succeeded: true,
    });
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id!));
    expect(row?.userId).toBe('user_runner');
    expect(row?.notificationType).toBe('workflow_completed');
    expect(row?.severity).toBe('success');
  });

  it('skips a scheduled run whose workflow has no owner (nobody to tell)', async () => {
    expect(
      await notifyRunFinished({ ...base, createdBy: null, triggeredBy: 'system', db, rt: null, settings: {}, succeeded: false }),
    ).toBeNull();
  });

  it('still returns the id when the live publish fails', async () => {
    const id = await notifyRunFinished({
      ...base,
      db,
      rt: { notify: vi.fn(async () => { throw new Error('realtime down'); }) },
      settings: {},
      succeeded: false,
    });
    expect(id).not.toBeNull();
  });
});
