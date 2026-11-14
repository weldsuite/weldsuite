import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { handleQueue, handleScheduled, runIdFor } from './index';
import type { Env } from './env';
import { fakeBatch, fakeMessage, fakeNamespace, newLedger } from './testing/fakes';

afterEach(() => vi.restoreAllMocks());

function envWith(ledger = newLedger()) {
  const env = { MAINTENANCE_LEDGER: fakeNamespace(() => ledger) } as unknown as Env;
  return { env, ledger };
}

const erase = { type: 'erase', workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1', 'ck_1'] };

describe('queue consumer', () => {
  it('records an erasure in the ledger and acknowledges it', async () => {
    const { env, ledger } = envWith();
    const message = fakeMessage(erase);
    await handleQueue(fakeBatch([message]), env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect((await ledger.pending())[0]).toMatchObject({ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['ck_1', 'u1'] });
  });

  it('records every message of a batch, and handles the same erasure arriving twice', async () => {
    const { env, ledger } = envWith();
    const messages = [fakeMessage(erase, 'm1'), fakeMessage(erase, 'm2'), fakeMessage({ ...erase, projectId: 'pnp_2', ids: ['u7'] }, 'm3')];
    await handleQueue(fakeBatch(messages), env);

    for (const message of messages) expect(message.ack).toHaveBeenCalled();
    expect((await ledger.pending()).map((p) => [p.projectId, p.ids])).toEqual([
      ['pnp_1', ['ck_1', 'u1']],
      ['pnp_2', ['u7']],
    ]);
  });

  it('drops a malformed message without retrying it and without logging the ids', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, ledger } = envWith();
    const bad = [
      fakeMessage({ ...erase, type: 'wipe' }, 'bad1'),
      fakeMessage({ ...erase, ids: [] }, 'bad2'),
      fakeMessage({ type: 'erase', workspaceId: 'ws_a', ids: ['secret-person'] }, 'bad3'),
      fakeMessage('nonsense', 'bad4'),
    ];
    await handleQueue(fakeBatch(bad), env);

    for (const message of bad) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(await ledger.pending()).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-person');
  });

  it('retries a message when the ledger fails, and carries on with the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, ledger } = envWith();
    const original = ledger.addErasure.bind(ledger);
    let calls = 0;
    ledger.addErasure = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('storage down');
      return original(...args);
    };
    const first = fakeMessage(erase, 'm1');
    const second = fakeMessage({ ...erase, projectId: 'pnp_2' }, 'm2');
    await handleQueue(fakeBatch([first, second]), env);

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe('weekly cron', () => {
  const SUNDAY = Date.parse('2026-11-15T03:00:00.000Z');

  it('names the run after the UTC day', () => {
    expect(runIdFor(SUNDAY)).toBe('maintenance-2026-11-15');
  });

  it('starts the workflow once per day', async () => {
    const create = vi.fn(async () => ({}));
    const env = { MAINTENANCE_WORKFLOW: { create } } as unknown as Env;

    expect(await handleScheduled({ scheduledTime: SUNDAY }, env)).toBe('maintenance-2026-11-15');
    expect(create).toHaveBeenCalledWith({ id: 'maintenance-2026-11-15', params: {} });
  });

  it('does nothing when the day\'s run already exists, and fails on any other error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exists = { MAINTENANCE_WORKFLOW: { create: async () => Promise.reject(new Error('instance.already_exists')) } } as unknown as Env;
    expect(await handleScheduled({ scheduledTime: SUNDAY }, exists)).toBeNull();
    expect(warn).toHaveBeenCalled();

    const broken = { MAINTENANCE_WORKFLOW: { create: async () => Promise.reject(new Error('quota exceeded')) } } as unknown as Env;
    await expect(handleScheduled({ scheduledTime: SUNDAY }, broken)).rejects.toThrow('quota exceeded');
  });
});

describe('fetch', () => {
  it('serves nothing', async () => {
    const res = await worker.fetch(new Request('https://panel-maintenance.example/'));
    expect(res.status).toBe(404);
  });
});
