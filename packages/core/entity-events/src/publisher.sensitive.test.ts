import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEvent, publishEntityEventRaw } from './publisher';

function mockQueue() {
  return { send: vi.fn(async (_message: unknown) => undefined) };
}

function sentMessage(queue: ReturnType<typeof mockQueue>) {
  expect(queue.send).toHaveBeenCalledTimes(1);
  return queue.send.mock.calls[0]![0] as {
    data: Record<string, unknown>;
    changes?: Record<string, { old: unknown; new: unknown }>;
  };
}

describe('entity events never carry ciphertext columns', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const partyRow = {
    id: 'party_1',
    displayName: 'Acme Plumbing',
    tinType: 'ein',
    tinLast4: '6789',
    sensitiveEncrypted: 'aesgcm:ciphertext-of-tin',
  };

  it('strips them from data and changes (raw publisher)', async () => {
    const ENTITY_EVENTS = mockQueue();
    await publishEntityEventRaw({
      env: { ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue },
      workspaceId: 'org_1',
      userId: 'user_1',
      entityType: 'customer',
      action: 'updated',
      entityId: 'party_1',
      data: { ...partyRow, entity: { id: 'ent_1', ssnEncrypted: 'ssn-blob', ssnLast4: '1234' } },
      changes: {
        displayName: { old: 'Acme', new: 'Acme Plumbing' },
        sensitiveEncrypted: { old: 'old-blob', new: 'aesgcm:ciphertext-of-tin' },
      },
    });

    const msg = sentMessage(ENTITY_EVENTS);
    expect(msg.data).toEqual({
      id: 'party_1',
      displayName: 'Acme Plumbing',
      tinType: 'ein',
      tinLast4: '6789',
      entity: { id: 'ent_1', ssnLast4: '1234' },
    });
    expect(msg.changes).toEqual({ displayName: { old: 'Acme', new: 'Acme Plumbing' } });
    expect(JSON.stringify(msg)).not.toMatch(/ciphertext|blob|Encrypted/);
  });

  it('strips them on the Hono-context publisher too', () => {
    const ENTITY_EVENTS = mockQueue();
    const waitUntil = vi.fn();
    const vars: Record<string, string> = { workspaceId: 'org_1', userId: 'user_1' };
    const c = {
      env: { ENTITY_EVENTS },
      get: (key: string) => vars[key],
      executionCtx: { waitUntil },
    };

    publishEntityEvent({
      c: c as never,
      entityType: 'customer',
      action: 'created',
      entityId: 'party_1',
      data: partyRow as never,
    });

    const msg = sentMessage(ENTITY_EVENTS);
    expect('sensitiveEncrypted' in msg.data).toBe(false);
    expect(msg.data.tinLast4).toBe('6789');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('leaves a payload without them untouched', async () => {
    const ENTITY_EVENTS = mockQueue();
    const data = { id: 'cus_1', name: 'Acme', tags: ['a'] };
    await publishEntityEventRaw({
      env: { ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue },
      workspaceId: 'org_1',
      userId: 'user_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data,
    });
    expect(sentMessage(ENTITY_EVENTS).data).toEqual(data);
  });
});
